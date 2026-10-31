import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { caseEmbeddings, cases } from "@/db/schema";
import type { Database } from "@/db/types";
import { PUBLIC_CASE_STATUSES } from "@/lib/config/constants";
import { logger } from "@/lib/config/logger";
import { buildEmbeddingInput, checkInput, hashEmbeddingInput } from "@/lib/embeddings/input";
import { EmbeddingError, type EmbeddingProvider } from "@/lib/embeddings/provider";
import type { CaseListItem } from "@/lib/serializers/toAgentView";
import { loadItems } from "./searchService";

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
 * Walks the public cases, oldest first, and collects the ones that need a vector for `model`: none stored, or one made
 * from older text. A case that fails the second redaction pass is counted but never listed: it would stay at the front
 * of every run and starve the rest. The scan stops once `limit` stale cases are found, so `unsafe` is a lower bound.
 * It reads cases in pages and hashes their text, so its cost grows with the number of public cases; that is fine at
 * launch size, and the cron batch keeps one run short.
 */
async function scanStale(db: Database, model: string, limit: number): Promise<{ stale: string[]; unsafe: number }> {
  const stale: string[] = [];
  let unsafe = 0;
  if (limit <= 0) return { stale, unsafe };
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
      if (!checkInput(input).ok) {
        unsafe++;
        continue;
      }
      stale.push(row.id);
      if (stale.length >= limit) break;
    }
    if (rows.length < SCAN_BATCH) break;
  }
  return { stale, unsafe };
}

/** Ids of public cases that need a vector for `model`, oldest first, at most `limit`. */
export async function findStaleCases(db: Database, model: string, limit: number): Promise<string[]> {
  return (await scanStale(db, model, limit)).stale;
}

// How many stale cases beyond the batch a run looks for, only to say that more work is waiting.
const REMAINING_CAP = 100;

/**
 * One run of the re-embed cron: embeds up to `limit` stale cases, oldest first, one provider call each, and stops
 * before starting a case once the deadline has passed. Returns counts only. `remaining` is the stale cases left, counted
 * up to 100 beyond the batch. A case the provider failed on is left for the next run. Idempotent.
 */
export async function reembedStale(
  db: Database,
  provider: EmbeddingProvider,
  options: { limit: number; timeoutMs: number; deadline: number; clock?: () => number },
): Promise<{ embedded: number; current: number; unsafe: number; failed: number; remaining: number }> {
  const clock = options.clock ?? Date.now;
  const { stale, unsafe } = await scanStale(db, provider.model, options.limit + REMAINING_CAP);
  const counts = { embedded: 0, current: 0, unsafe, failed: 0, remaining: 0 };
  let processed = 0;
  for (const id of stale) {
    if (processed >= options.limit || clock() >= options.deadline) break;
    processed++;
    const { status } = await embedCase(db, provider, id, { timeoutMs: options.timeoutMs });
    if (status === "embedded") counts.embedded++;
    else if (status === "current") counts.current++;
    else if (status === "unsafe") counts.unsafe++;
    else if (status === "failed") counts.failed++;
  }
  counts.remaining = stale.length - processed;
  return counts;
}

/**
 * Embeds a case and answers with the resolved cases nearest to it: above `minSimilarity`, nearest first, at most
 * `limit`, never the case itself and never a case that is not resolved. The comparison happens inside the database
 * against the vector just stored, so no vector reaches this code. Any failure, a case that is not public, or a case
 * that cannot be embedded gives an empty list.
 */
export async function embedAndFindSimilar(
  db: Database,
  provider: EmbeddingProvider,
  caseId: string,
  options: { limit: number; minSimilarity: number; timeoutMs?: number },
): Promise<CaseListItem[]> {
  const embedded = await embedCase(db, provider, caseId, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
  if (embedded.status !== "embedded" && embedded.status !== "current") return [];

  const ownVector = sql`(select "embedding" from "case_embeddings" where "case_id" = ${caseId}::uuid and "model" = ${provider.model})`;
  const distance = sql`${caseEmbeddings.embedding} <=> ${ownVector}`;
  const rows = await db
    .select({ id: cases.id })
    .from(caseEmbeddings)
    .innerJoin(cases, eq(cases.id, caseEmbeddings.caseId))
    .where(
      and(
        eq(caseEmbeddings.model, provider.model),
        eq(cases.status, "resolved"),
        ne(cases.id, caseId),
        sql`${distance} <= ${1 - options.minSimilarity}`,
      ),
    )
    .orderBy(distance, cases.id)
    .limit(options.limit);
  if (rows.length === 0) return [];

  const items = await loadItems(db, rows.map((row) => row.id));
  return rows.flatMap((row) => {
    const item = items.get(row.id);
    return item ? [item] : [];
  });
}
