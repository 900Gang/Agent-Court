import { getDb } from "@/db/client";
import type { Database } from "@/db/types";
import { getServerEnv } from "@/lib/config/env";
import { createGate } from "@/lib/safety/engine";
import type { SafetyGate } from "@/lib/safety/gate";
import { rescanHeld } from "@/lib/services/rescanService";
import { jsonResponse } from "../apiPipeline";
import { verifyCronRequest } from "../cronAuth";
import { errorResponse } from "../errors";

export type CronDeps = { db: Database; gate: SafetyGate; secret: string | null };

/** The real wiring for the cron route files. */
export function getCronDeps(): CronDeps {
  return { db: getDb(), gate: createGate(), secret: getServerEnv().cronSecret };
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
