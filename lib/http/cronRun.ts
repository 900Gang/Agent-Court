import { and, desc, eq, notInArray } from "drizzle-orm";
import { cronRuns } from "@/db/schema";
import type { Database } from "@/db/types";
import { OPS, type CronRoute } from "@/lib/config/constants";
import { logger } from "@/lib/config/logger";
import { safeErrorFields } from "@/lib/config/safeError";

// Every scheduled route runs its job through runCron (N10). One row per run goes to cron_runs: the route, the start and
// the end, whether it succeeded, and the counts the job reported. The row never holds a message or any text. The
// metrics page and the alert check read it to see that each job is still running.

const COUNT_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const MAX_COUNTS = 20;

/** Only numbers and booleans from a job's summary, under plain names. A string is dropped: counts never carry text. */
export function countsOf(summary: unknown): Record<string, number | boolean> {
  const counts: Record<string, number | boolean> = {};
  if (typeof summary !== "object" || summary === null || Array.isArray(summary)) return counts;
  for (const [name, value] of Object.entries(summary)) {
    if (Object.keys(counts).length >= MAX_COUNTS) break;
    if (!COUNT_NAME.test(name)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) counts[name] = value;
  }
  return counts;
}

async function record(db: Database, route: CronRoute, startedAt: Date, finishedAt: Date, ok: boolean, counts: Record<string, number | boolean>) {
  try {
    await db.insert(cronRuns).values({ route, startedAt, finishedAt, ok, counts });
    // Keep the newest rows of this route only. A failed prune is not an error: the next run tries again.
    const newest = db
      .select({ id: cronRuns.id })
      .from(cronRuns)
      .where(eq(cronRuns.route, route))
      .orderBy(desc(cronRuns.finishedAt), desc(cronRuns.id))
      .limit(OPS.scheduledRunsKept);
    await db.delete(cronRuns).where(and(eq(cronRuns.route, route), notInArray(cronRuns.id, newest)));
  } catch (error) {
    // Recording must never turn a good run into a failed one, or hide a failed one.
    logger.warn("cron run not recorded", { route, ...safeErrorFields(error) });
  }
}

/**
 * Runs a scheduled job and records the run. The job's own summary is returned unchanged. If it throws, a failed run is
 * recorded (with no counts) and the same error is thrown again, so the route still answers as it did before.
 */
export async function runCron<T extends Record<string, unknown>>(
  db: Database,
  route: CronRoute,
  job: () => Promise<T>,
  clock: () => Date = () => new Date(),
): Promise<T> {
  const startedAt = clock();
  let summary: T;
  try {
    summary = await job();
  } catch (error) {
    await record(db, route, startedAt, clock(), false, {});
    throw error;
  }
  await record(db, route, startedAt, clock(), true, countsOf(summary));
  return summary;
}
