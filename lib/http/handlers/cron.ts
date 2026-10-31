import { getDb } from "@/db/client";
import type { Database } from "@/db/types";
import { EMBEDDING, SEARCH_TUNING } from "@/lib/config/constants";
import { getServerEnv } from "@/lib/config/env";
import type { EmbeddingProvider } from "@/lib/embeddings/provider";
import { getEmbeddingProvider } from "@/lib/embeddings/server";
import { createGate } from "@/lib/safety/engine";
import type { SafetyGate } from "@/lib/safety/gate";
import { reembedStale } from "@/lib/services/embeddingService";
import { rescanHeld } from "@/lib/services/rescanService";
import { jsonResponse } from "../apiPipeline";
import { verifyCronRequest } from "../cronAuth";
import { errorResponse } from "../errors";

export type CronDeps = { db: Database; gate: SafetyGate; secret: string | null; embedder?: EmbeddingProvider | null };

/** The real wiring for the cron route files. */
export function getCronDeps(): CronDeps {
  return { db: getDb(), gate: createGate(), secret: getServerEnv().cronSecret, embedder: getEmbeddingProvider() };
}

const BATCH = 100;

/**
 * GET or POST /api/cron/rescan. Every refusal is the same fixed 401. A correct call re-screens one batch of held
 * content with the current gate (redacting in place, rejecting what now blocks, never publishing) and answers
 * with the counts only. The next scheduled call takes the next batch.
 */
export async function handleCronRescan(request: Request, deps: CronDeps): Promise<Response> {
  if (!verifyCronRequest(request, deps.secret)) return errorResponse("unauthorized");
  const summary = await rescanHeld(deps.db, deps.gate, { limit: BATCH, apply: true });
  return jsonResponse(200, summary);
}

/**
 * GET or POST /api/cron/reembed. The secret is checked first, and every refusal is the same fixed 401. A correct call
 * embeds one batch of public cases that have no current vector (new ones, and ones whose text changed, as after a
 * redaction) and answers with counts only. With no embeddings provider configured it answers 200 with zeros and
 * `disabled: true`: not having a key is a setting, not an error. The next scheduled call takes the next batch.
 */
export async function handleCronReembed(request: Request, deps: CronDeps): Promise<Response> {
  if (!verifyCronRequest(request, deps.secret)) return errorResponse("unauthorized");
  if (!deps.embedder) {
    return jsonResponse(200, { disabled: true, embedded: 0, current: 0, unsafe: 0, failed: 0, remaining: 0 });
  }
  const summary = await reembedStale(deps.db, deps.embedder, {
    limit: SEARCH_TUNING.cronBatch,
    timeoutMs: EMBEDDING.cronTimeoutMs,
    deadline: Date.now() + SEARCH_TUNING.cronBudgetMs,
  });
  return jsonResponse(200, { disabled: false, ...summary });
}
