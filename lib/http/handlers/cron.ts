import { getDb } from "@/db/client";
import type { Database } from "@/db/types";
import { EMBEDDING, LIFECYCLE, SEARCH_TUNING } from "@/lib/config/constants";
import { getServerEnv } from "@/lib/config/env";
import type { EmbeddingProvider } from "@/lib/embeddings/provider";
import { getEmbeddingProvider } from "@/lib/embeddings/server";
import type { EmailProvider } from "@/lib/email/provider";
import { getEmailProvider } from "@/lib/email/server";
import { createGate } from "@/lib/safety/engine";
import type { SafetyGate } from "@/lib/safety/gate";
import { reembedStale } from "@/lib/services/embeddingService";
import { closeIdleCases } from "@/lib/services/lifecycleService";
import { sendDueNotices } from "@/lib/services/notificationService";
import { releaseDue } from "@/lib/services/reputationService";
import { rescanHeld } from "@/lib/services/rescanService";
import { jsonResponse } from "../apiPipeline";
import { verifyCronRequest } from "../cronAuth";
import { errorResponse } from "../errors";

export type CronDeps = { db: Database; gate: SafetyGate; secret: string | null; embedder?: EmbeddingProvider | null; /** The mail provider. Null or absent: no email is sent. */ mailer?: EmailProvider | null; /** The site's own address, for links in email. */ baseUrl?: string; /** The time the jobs use. Absent in production; tests set it. */ now?: Date };

/** The real wiring for the cron route files. */
export function getCronDeps(): CronDeps {
  return { db: getDb(), gate: createGate(), secret: getServerEnv().cronSecret, embedder: getEmbeddingProvider(), mailer: getEmailProvider(), baseUrl: getServerEnv().betterAuthUrl };
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

/**
 * GET or POST /api/cron/auto-close. The secret is checked first, and every refusal is the same fixed 401. A correct call
 * closes one batch of idle cases (open or argued, 14 days after publication, no verdict) and answers with counts only.
 * The next scheduled call takes the next batch.
 */
export async function handleCronAutoClose(request: Request, deps: CronDeps): Promise<Response> {
  if (!verifyCronRequest(request, deps.secret)) return errorResponse("unauthorized");
  const summary = await closeIdleCases(deps.db, deps.now ?? new Date(), { limit: LIFECYCLE.cronBatch });
  return jsonResponse(200, summary);
}

/**
 * GET or POST /api/cron/release-reputation. The secret is checked first, and every refusal is the same fixed 401. A
 * correct call makes every pending event whose time has come final, unless its verdict is under appeal or overturned, and
 * answers with the count only. This is the one thing that lets an agent's tier rise.
 */
export async function handleCronReleaseReputation(request: Request, deps: CronDeps): Promise<Response> {
  if (!verifyCronRequest(request, deps.secret)) return errorResponse("unauthorized");
  const released = await releaseDue(deps.db, deps.now ?? new Date());
  return jsonResponse(200, { released });
}

/**
 * GET or POST /api/cron/reminders. The secret is checked first, and every refusal is the same fixed 401. A correct call
 * sends the email notices that are due (reminders, new arguments, appeal outcomes, closed cases) and answers with counts
 * only. With no mail provider configured, or no address to build links from, it answers 200 with `disabled: true` and
 * zeros: not having a mail account is a setting, not an error. A failing provider is counted, never an error.
 */
export async function handleCronReminders(request: Request, deps: CronDeps): Promise<Response> {
  if (!verifyCronRequest(request, deps.secret)) return errorResponse("unauthorized");
  if (!deps.mailer || !deps.baseUrl) {
    return jsonResponse(200, { disabled: true, sent: 0, failed: 0, skippedNoAddress: 0, alreadySent: 0 });
  }
  const summary = await sendDueNotices(deps.db, deps.mailer, deps.now ?? new Date(), { baseUrl: deps.baseUrl, limit: LIFECYCLE.cronBatch });
  return jsonResponse(200, { disabled: false, ...summary });
}
