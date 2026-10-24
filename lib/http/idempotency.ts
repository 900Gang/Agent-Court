import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { idempotencyKeys, type IdempotencyKey } from "@/db/schema";
import type { Database } from "@/db/types";
import { IDEMPOTENCY_TTL_HOURS } from "@/lib/config/constants";
import { errorResponse } from "./errors";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** JSON with object keys sorted at every depth, so the same request always serializes the same way. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A fingerprint of method, path and body. The same Idempotency-Key must always come with the same fingerprint. */
export function hashRequest(method: string, path: string, body: unknown): string {
  return sha256(`${method}\n${path}\n${canonical(body)}`);
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function replayOrConflict(existing: IdempotencyKey, requestHash: string): Response {
  if (existing.requestHash !== requestHash || existing.responseRef === null) {
    return errorResponse("idempotency_conflict");
  }
  try {
    const stored = JSON.parse(existing.responseRef) as { status: number; body: string };
    return new Response(stored.body, { status: stored.status, headers: { ...JSON_HEADERS, "Idempotent-Replay": "true" } });
  } catch {
    return errorResponse("idempotency_conflict");
  }
}

type Input = { agentId: string; key: string | null; requestHash: string; now: Date };

async function find(tx: Database, keyHash: string, agentId: string): Promise<IdempotencyKey | undefined> {
  const [row] = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.keyHash, keyHash), eq(idempotencyKeys.agentId, agentId)))
    .limit(1);
  return row;
}

/**
 * Runs `work` once per Idempotency-Key. The claim, the write and the stored response share one transaction,
 * so a crash cannot leave a claim without a response. Only 2xx responses are kept. A non-2xx response drops the
 * claim, so the key can be used again, but commits the rest: services return their failures before they write,
 * and the one write that must survive a refusal is the moderation event for blocked content. An exception
 * rolls the whole transaction back.
 * A concurrent request with the same key waits on the claim insert, then replays the winner's response.
 */
export async function runIdempotent(
  db: Database,
  input: Input,
  work: (tx: Database) => Promise<Response>,
): Promise<Response> {
  const keyHash = input.key === null ? null : sha256(input.key);
  return db.transaction(async (tx): Promise<Response> => {
      if (keyHash !== null) {
        let existing = await find(tx, keyHash, input.agentId);
        if (existing && existing.createdAt.getTime() < input.now.getTime() - IDEMPOTENCY_TTL_HOURS * 3_600_000) {
          await tx
            .delete(idempotencyKeys)
            .where(and(eq(idempotencyKeys.keyHash, keyHash), eq(idempotencyKeys.agentId, input.agentId)));
          existing = undefined;
        }
        if (existing) return replayOrConflict(existing, input.requestHash);

        const claimed = await tx
          .insert(idempotencyKeys)
          .values({ keyHash, agentId: input.agentId, requestHash: input.requestHash, createdAt: input.now })
          .onConflictDoNothing()
          .returning({ keyHash: idempotencyKeys.keyHash });
        if (claimed.length === 0) {
          // A concurrent request claimed the key first and has committed by now.
          const winner = await find(tx, keyHash, input.agentId);
          if (!winner) throw new Error("idempotency claim disappeared");
          return replayOrConflict(winner, input.requestHash);
        }
      }

      const response = await work(tx);
      if (keyHash === null) return response;
      if (response.status < 200 || response.status >= 300) {
        await tx
          .delete(idempotencyKeys)
          .where(and(eq(idempotencyKeys.keyHash, keyHash), eq(idempotencyKeys.agentId, input.agentId)));
        return response;
      }

      const text = await response.text();
      await tx
        .update(idempotencyKeys)
        .set({ responseRef: JSON.stringify({ status: response.status, body: text }) })
        .where(and(eq(idempotencyKeys.keyHash, keyHash), eq(idempotencyKeys.agentId, input.agentId)));
      return new Response(text, { status: response.status, headers: response.headers });
  });
}
