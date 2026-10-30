import { and, asc, eq, inArray } from "drizzle-orm";
import { caseEmbeddings, cases } from "@/db/schema";
import type { Database } from "@/db/types";
import { PUBLIC_CASE_STATUSES } from "@/lib/config/constants";
import { logger } from "@/lib/config/logger";
import { buildEmbeddingInput, checkInput, hashEmbeddingInput } from "@/lib/embeddings/input";
import { EmbeddingError, type EmbeddingProvider } from "@/lib/embeddings/provider";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC = [...PUBLIC_CASE_STATUSES];
const PUBLIC_SET = new Set<string>(PUBLIC);

export type EmbedStatus = "embedded" | "current" | "not_public" | "unsafe" | "failed";

function isVector(value: unknown, dimensions: number): value is number[] {
  return Array.isArray(value) && value.length === dimensions && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

/**
 * Embeds one public case. Reads the stored fields, checks the input a second time, skips a case whose text has not
 * changed, asks the provider, and stores the vector with the hash of the text it was made from. A held, withdrawn,
 * rejected, unknown or malformed case is `not_public`, and the provider is not called. A provider failure never
 * throws and never deletes an older vector. Logs carry the case id and rule names or an error code, never text.
 */
export async function embedCase(
  db: Database,
  provider: EmbeddingProvider,
  caseId: string,
  options: { timeoutMs?: number } = {},
): Promise<{ status: EmbedStatus }> {
  if (!UUID.test(caseId)) return { status: "not_public" };
  const [row] = await db
    .select({
      status: cases.status,
      title: cases.title,
      summary: cases.summary,
      expected: cases.expected,
      actual: cases.actual,
      environment: cases.environment,
      tags: cases.tags,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);
  if (!row || !PUBLIC_SET.has(row.status)) return { status: "not_public" };

  const input = buildEmbeddingInput(row);
  const checked = checkInput(input);
  if (!checked.ok) {
    logger.warn("embedding refused: stored text failed the second redaction pass", { caseId, rules: checked.rules });
    return { status: "unsafe" };
  }

  const hash = hashEmbeddingInput(provider.model, input);
  const [existing] = await db
    .select({ hash: caseEmbeddings.textHash })
    .from(caseEmbeddings)
    .where(and(eq(caseEmbeddings.caseId, caseId), eq(caseEmbeddings.model, provider.model)))
    .limit(1);
  if (existing?.hash === hash) return { status: "current" };

  let vectors: number[][];
  try {
    vectors = await (options.timeoutMs === undefined ? provider.embed([input]) : provider.embed([input], { timeoutMs: options.timeoutMs }));
  } catch (error) {
    logger.warn("embedding failed", { caseId, code: error instanceof EmbeddingError ? error.code : "unknown" });
    return { status: "failed" };
  }
  const vector = vectors.length === 1 ? vectors[0] : undefined;
  if (!isVector(vector, provider.dimensions)) {
    logger.warn("embedding failed", { caseId, code: "shape" });
    return { status: "failed" };
  }

  try {
    // A nested transaction is a savepoint, so a failed write cannot poison the transaction this may run inside.
    await db.transaction(async (tx) => {
      await tx
        .insert(caseEmbeddings)
        .values({ caseId, model: provider.model, dim: vector.length, embedding: vector, textHash: hash })
        .onConflictDoUpdate({
          target: [caseEmbeddings.caseId, caseEmbeddings.model],
          set: { dim: vector.length, embedding: vector, textHash: hash, createdAt: new Date() },
        });
    });
  } catch {
    logger.warn("embedding failed", { caseId, code: "store" });
    return { status: "failed" };
  }
  return { status: "embedded" };
}

const SCAN_BATCH = 200;

/**
 * Ids of public cases that need a vector for `model`: none stored, or one made from older text. Oldest first, at
 * most `limit`. A case that fails the second redaction pass is left out: it would stay at the front of every run
 * and starve the rest. It is reported by `embedCase`, not here. This reads cases in pages and hashes their text, so
 * its cost grows with the number of public cases; that is fine at launch size, and the cron batch keeps one run short.
 */
export async function findStaleCases(db: Database, model: string, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const stale: string[] = [];
  for (let offset = 0; stale.length < limit; offset += SCAN_BATCH) {
    const rows = await db
      .select({
        id: cases.id,
        title: cases.title,
        summary: cases.summary,
        expected: cases.expected,
        actual: cases.actual,
        environment: cases.environment,
        tags: cases.tags,
        storedHash: caseEmbeddings.textHash,
      })
      .from(cases)
      .leftJoin(caseEmbeddings, and(eq(caseEmbeddings.caseId, cases.id), eq(caseEmbeddings.model, model)))
      .where(inArray(cases.status, PUBLIC))
      .orderBy(asc(cases.createdAt), asc(cases.id))
      .limit(SCAN_BATCH)
      .offset(offset);
    for (const row of rows) {
      const input = buildEmbeddingInput(row);
      if (row.storedHash === hashEmbeddingInput(model, input)) continue;
      if (!checkInput(input).ok) continue;
      stale.push(row.id);
      if (stale.length >= limit) break;
    }
    if (rows.length < SCAN_BATCH) break;
  }
  return stale;
}
