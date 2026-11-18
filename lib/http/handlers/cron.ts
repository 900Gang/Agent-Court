import { getDb } from "@/db/client";
import type { Database } from "@/db/types";
import { EMBEDDING, LIFECYCLE, SEARCH_TUNING } from "@/lib/config/constants";
import { getServerEnv } from "@/lib/config/env";
import type { EmbeddingProvider } from "@/lib/embeddings/provider";
import { getEmbeddingProvider } from "@/lib/embeddings/server";
import type { EmailProvider } from "@/lib/email/provider";
import { getEmailProvider } from "@/lib/email/server";
import type { Counters } from "@/lib/metrics/counters";
import { getCounters } from "@/lib/metrics/server";
import { createGate } from "@/lib/safety/engine";
import type { SafetyGate } from "@/lib/safety/gate";
import { runHealthCheck } from "@/lib/services/alertService";
import { reembedStale } from "@/lib/services/embeddingService";
import { closeIdleCases } from "@/lib/services/lifecycleService";
import { sendDueNotices } from "@/lib/services/notificationService";
import { releaseDue } from "@/lib/services/reputationService";
import { rescanHeld } from "@/lib/services/rescanService";
import { jsonResponse } from "../apiPipeline";
import { runCron } from "../cronRun";
import { verifyCronRequest } from "../cronAuth";
import { errorResponse } from "../errors";

export type CronDeps = { db: Database; gate: SafetyGate; secret: string | null; embedder?: EmbeddingProvider | null; /** The mail provider. Null or absent: no email is sent. */ mailer?: EmailProvider | null; /** The site's own address, for links in email. */ baseUrl?: string; /** The time the jobs use. Absent in production; tests set it. */ now?: Date; /** The request counters, for the alert check. Null or absent: the 429 rule is skipped. */ counters?: Counters | null; /** The alert address. Null or absent: the alert check sends nothing. */ alertTo?: string | null };

/** The real wiring for the cron route files. */
export function getCronDeps(): CronDeps {
  return { db: getDb(), gate: createGate(), secret: getServerEnv().cronSecret, embedder: getEmbeddingProvider(), mailer: getEmailProvider(), baseUrl: getServerEnv().betterAuthUrl, counters: getCounters(), alertTo: getServerEnv().alertEmail };
}

const BATCH = 100;

/**
 * GET or POST /api/cron/rescan. Every refusal is the same fixed 401. A correct call re-screens one batch of held
 * content with the current gate (redacting in place, rejecting what now blocks, never publishing) and answers
 * with the counts only. The next scheduled call takes the next batch.
 */
export async function handleCronRescan(request: Request, deps: CronDeps): Promise<Response> {
  if (!verifyCronRequest(request, deps.secret)) return errorResponse("unauthorized");
  const summary = await runCron(deps.db, "rescan", () => rescanHeld(deps.db, deps.gate, { limit: BATCH, apply: true }));
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
  const embedder = deps.embedder;
  const summary = await runCron(deps.db, "reembed", async () => {
    if (!embedder) return { disabled: true, embedded: 0, current: 0, unsafe: 0, failed: 0, remaining: 0 };
    const done = await reembedStale(deps.db, embedder, {
      limit: SEARCH_TUNING.cronBatch,
      timeoutMs: EMBEDDING.cronTimeoutMs,
      deadline: Date.now() + SEARCH_TUNING.cronBudgetMs,
    });
    return { disabled: false, ...done };
  });
  return jsonResponse(200, summary);
}

/**
 * GET or POST /api/cron/auto-close. The secret is checked first, and every refusal is the same fixed 401. A correct call
 * closes one batch of idle cases (open or argued, 14 days after publication, no verdict) and answers with counts only.
 * The next scheduled call takes the next batch.
 */
export async function handleCronAutoClose(request: Request, deps: CronDeps): Promise<Response> {
  if (!verifyCronRequest(request, deps.secret)) return errorResponse("unauthorized");
  const summary = await runCron(deps.db, "auto-close", () => closeIdleCases(deps.db, deps.now ?? new Date(), { limit: LIFECYCLE.cronBatch }));
  return jsonResponse(200, summary);
}

/**
 * GET or POST /api/cron/release-reputation. The secret is checked first, and every refusal is the same fixed 401. A
 * correct call makes every pending event whose time has come final, unless its verdict is under appeal or overturned, and
 * answers with the count only. This is the one thing that lets an agent's tier rise.
 */
export async function handleCronReleaseReputation(request: Request, deps: CronDeps): Promise<Response> {
  if (!verifyCronRequest(request, deps.secret)) return errorResponse("unauthorized");
  const summary = await runCron(deps.db, "release-reputation", async () => ({ released: await releaseDue(deps.db, deps.now ?? new Date()) }));
  return jsonResponse(200, summary);
}

/**
 * GET or POST /api/cron/reminders. The secret is checked first, and every refusal is the same fixed 401. A correct call
 * sends the email notices that are due (reminders, new arguments, appeal outcomes, closed cases) and answers with counts
 * only. With no mail provider configured, or no address to build links from, it answers 200 with `disabled: true` and
 * zeros: not having a mail account is a setting, not an error. A failing provider is counted, never an error.
 */
export async function handleCronReminders(request: Request, deps: CronDeps): Promise<Response> {
  if (!verifyCronRequest(request, deps.secret)) return errorResponse("unauthorized");
  const mailer = deps.mailer;
  const baseUrl = deps.baseUrl;
  const summary = await runCron(deps.db, "reminders", async () => {
    if (!mailer || !baseUrl) return { disabled: true, sent: 0, failed: 0, skippedNoAddress: 0, alreadySent: 0 };
    const done = await sendDueNotices(deps.db, mailer, deps.now ?? new Date(), { baseUrl, limit: LIFECYCLE.cronBatch });
    return { disabled: false, ...done };
  });
  return jsonResponse(200, summary);
}

/**
 * GET or POST /api/cron/health-check. The secret is checked first, and every refusal is the same fixed 401. A correct call
 * applies the three alert rules (flag rate, 429 rate, a missed scheduled route) to the current numbers and emails one
 * message for each rule that fires and is not cooling down. It answers with counts only. With no alert address, mail
 * provider or site address it answers 200 with `disabled: true` and sends nothing.
 */
export async function handleCronHealthCheck(request: Request, deps: CronDeps): Promise<Response> {
  if (!verifyCronRequest(request, deps.secret)) return errorResponse("unauthorized");
  const summary = await runCron(deps.db, "health-check", () =>
    runHealthCheck(deps.db, {
      counters: deps.counters ?? null,
      mailer: deps.mailer ?? null,
      to: deps.alertTo ?? null,
      baseUrl: deps.baseUrl ?? null,
      ...(deps.now ? { now: deps.now } : {}),
    }),
  );
  return jsonResponse(200, summary);
}
