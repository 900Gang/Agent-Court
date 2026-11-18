import { and, count, desc, eq, gte, inArray, lte, max, ne, sql, type AnyColumn } from "drizzle-orm";
import { cases, cronRuns, moderationEvents, verdicts } from "@/db/schema";
import type { Database } from "@/db/types";
import { OPS, PUBLIC_CASE_STATUSES, type CronRoute } from "@/lib/config/constants";
import type { Counters } from "@/lib/metrics/counters";

// The numbers behind /admin/metrics and the alert check (N10, AC-1005, AC-1006). Counts and times only: nothing in a
// result is text that anyone wrote. Every query is bounded by a time range and uses the created_at indexes.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DAYS = 7;
const HOURS = 24;
const RESOLUTION_AGE_DAYS = 7;

export type MetricsDay = {
  /** UTC day, yyyy-mm-dd. */
  day: string;
  /** Cases filed by agents (not imported ones) that day. */
  cases: number;
  /** Imported cases that were added that day: a separate line, since they are a one-off. */
  importedCases: number;
  /** Verdicts issued that day by operators (imported verdicts are not counted). */
  verdicts: number;
  /** Texts the gate screened for injection that day, and how many of them it flagged or blocked. */
  screened: number;
  flagged: number;
  /** Authenticated API requests and 429s that day. Null when the counters could not be read. */
  requests: number | null;
  rateLimited: number | null;
};

export type MetricsHour = {
  /** UTC hour, yyyy-mm-dd hh. */
  hour: string;
  screened: number;
  flagged: number;
  requests: number | null;
  rateLimited: number | null;
};

export type CronState = "ok" | "failed" | "overdue" | "never";

export type CronStatus = {
  route: CronRoute;
  expectedMinutes: number;
  lastRunAt: Date | null;
  lastOkAt: Date | null;
  state: CronState;
};

export type MetricsView = {
  generatedAt: Date;
  /** The last seven UTC days, oldest first, today last (today is not finished). */
  days: MetricsDay[];
  /** The last 24 UTC hours, oldest first, the current hour last. */
  hours: MetricsHour[];
  /** Cases filed by agents that are public and older than seven days, and how many of them have a verdict. */
  resolution: { eligible: number; resolved: number };
  cron: CronStatus[];
  /** False when the request counters could not be read, so their columns show unknown rather than zero. */
  countersAvailable: boolean;
};

const dayKey = (at: Date) => at.toISOString().slice(0, 10);
const hourKey = (at: Date) => `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 13)}`;
const startOfUtcDay = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
const startOfUtcHour = (at: Date) => new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);

const dayOf = (column: AnyColumn) => sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD')`;
const hourOf = (column: AnyColumn) => sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD HH24')`;

/** The state of one scheduled route from its newest run and its newest success. */
export function cronStateOf(input: { now: Date; expectedMinutes: number; lastRunAt: Date | null; lastRunOk: boolean | null; lastOkAt: Date | null }): CronState {
  if (input.lastRunAt === null) return "never";
  if (input.lastOkAt === null) return "failed";
  if (input.now.getTime() - input.lastOkAt.getTime() > 2 * input.expectedMinutes * 60_000) return "overdue";
  return input.lastRunOk === false ? "failed" : "ok";
}

/** The newest run and the newest success of every scheduled route, in the order of OPS.cronJobs. */
export async function loadCronStatus(db: Database, now: Date): Promise<CronStatus[]> {
  const lastRuns = await db.select({ route: cronRuns.route, at: max(cronRuns.finishedAt) }).from(cronRuns).groupBy(cronRuns.route);
  const lastOks = await db.select({ route: cronRuns.route, at: max(cronRuns.finishedAt) }).from(cronRuns).where(eq(cronRuns.ok, true)).groupBy(cronRuns.route);
  const newest = await db
    .select({ route: cronRuns.route, ok: cronRuns.ok })
    .from(cronRuns)
    .orderBy(desc(cronRuns.finishedAt), desc(cronRuns.id))
    .limit(Object.keys(OPS.cronJobs).length * OPS.scheduledRunsKept);

  const runAt = new Map(lastRuns.map((row) => [row.route, row.at]));
  const okAt = new Map(lastOks.map((row) => [row.route, row.at]));
  const lastOk = new Map<string, boolean>();
  for (const row of newest) if (!lastOk.has(row.route)) lastOk.set(row.route, row.ok);

  return (Object.keys(OPS.cronJobs) as CronRoute[]).map((route) => {
    const lastRunAt = runAt.get(route) ?? null;
    const lastOkAt = okAt.get(route) ?? null;
    const expectedMinutes = OPS.cronJobs[route];
    return { route, expectedMinutes, lastRunAt, lastOkAt, state: cronStateOf({ now, expectedMinutes, lastRunAt, lastRunOk: lastOk.get(route) ?? null, lastOkAt }) };
  });
}

/**
 * Everything the metrics page shows. `counters` may be absent or fail: the request columns are then null and
 * `countersAvailable` is false. A database that has no data gives zeros, not errors.
 */
export async function loadMetrics(db: Database, counters: Counters | null, now: Date = new Date()): Promise<MetricsView> {
  const today = startOfUtcDay(now);
  const firstDay = new Date(today.getTime() - (DAYS - 1) * DAY_MS);
  const currentHour = startOfUtcHour(now);
  const firstHour = new Date(currentHour.getTime() - (HOURS - 1) * HOUR_MS);

  const days: MetricsDay[] = Array.from({ length: DAYS }, (_unused, index) => ({
    day: dayKey(new Date(firstDay.getTime() + index * DAY_MS)),
    cases: 0,
    importedCases: 0,
    verdicts: 0,
    screened: 0,
    flagged: 0,
    requests: null,
    rateLimited: null,
  }));
  const hours: MetricsHour[] = Array.from({ length: HOURS }, (_unused, index) => ({
    hour: hourKey(new Date(firstHour.getTime() + index * HOUR_MS)),
    screened: 0,
    flagged: 0,
    requests: null,
    rateLimited: null,
  }));
  const dayAt = new Map(days.map((row) => [row.day, row]));
  const hourAt = new Map(hours.map((row) => [row.hour, row]));

  const caseRows = await db
    .select({ day: dayOf(cases.createdAt), source: cases.source, n: count() })
    .from(cases)
    .where(and(gte(cases.createdAt, firstDay), lte(cases.createdAt, now)))
    .groupBy(dayOf(cases.createdAt), cases.source);
  for (const row of caseRows) {
    const target = dayAt.get(row.day);
    if (!target) continue;
    if (row.source === "imported") target.importedCases += Number(row.n);
    else target.cases += Number(row.n);
  }

  const verdictRows = await db
    .select({ day: dayOf(verdicts.createdAt), n: count() })
    .from(verdicts)
    .where(and(gte(verdicts.createdAt, firstDay), lte(verdicts.createdAt, now), ne(verdicts.decidedBy, "imported")))
    .groupBy(dayOf(verdicts.createdAt));
  for (const row of verdictRows) {
    const target = dayAt.get(row.day);
    if (target) target.verdicts += Number(row.n);
  }

  const screenedDays = await db
    .select({ day: dayOf(moderationEvents.createdAt), result: moderationEvents.result, n: count() })
    .from(moderationEvents)
    .where(and(eq(moderationEvents.check, "injection"), gte(moderationEvents.createdAt, firstDay), lte(moderationEvents.createdAt, now)))
    .groupBy(dayOf(moderationEvents.createdAt), moderationEvents.result);
  for (const row of screenedDays) {
    const target = dayAt.get(row.day);
    if (!target) continue;
    target.screened += Number(row.n);
    if (row.result !== "pass") target.flagged += Number(row.n);
  }

  const screenedHours = await db
    .select({ hour: hourOf(moderationEvents.createdAt), result: moderationEvents.result, n: count() })
    .from(moderationEvents)
    .where(and(eq(moderationEvents.check, "injection"), gte(moderationEvents.createdAt, firstHour), lte(moderationEvents.createdAt, now)))
    .groupBy(hourOf(moderationEvents.createdAt), moderationEvents.result);
  for (const row of screenedHours) {
    const target = hourAt.get(row.hour);
    if (!target) continue;
    target.screened += Number(row.n);
    if (row.result !== "pass") target.flagged += Number(row.n);
  }

  const cutoff = new Date(now.getTime() - RESOLUTION_AGE_DAYS * DAY_MS);
  const [eligible] = await db
    .select({ n: count() })
    .from(cases)
    .where(and(eq(cases.source, "native"), inArray(cases.status, [...PUBLIC_CASE_STATUSES]), lte(cases.createdAt, cutoff)));
  const [resolved] = await db
    .select({ n: count() })
    .from(cases)
    .where(and(eq(cases.source, "native"), inArray(cases.status, ["resolved", "under_appeal"]), lte(cases.createdAt, cutoff)));

  let countersAvailable = false;
  if (counters) {
    try {
      const requests = await counters.read("requests", DAYS * 24);
      const limited = await counters.read("rate_limited", DAYS * 24);
      const lastHour = currentHour.getTime();
      requests.forEach((value, index) => {
        const at = new Date(lastHour - (requests.length - 1 - index) * HOUR_MS);
        const day = dayAt.get(dayKey(at));
        if (day) {
          day.requests = (day.requests ?? 0) + value;
          day.rateLimited = (day.rateLimited ?? 0) + (limited[index] ?? 0);
        }
        const hour = hourAt.get(hourKey(at));
        if (hour) {
          hour.requests = value;
          hour.rateLimited = limited[index] ?? 0;
        }
      });
      for (const day of days) {
        day.requests ??= 0;
        day.rateLimited ??= 0;
      }
      countersAvailable = true;
    } catch {
      // The numbers stay null: the page says unknown, not zero.
    }
  }

  return {
    generatedAt: now,
    days,
    hours,
    resolution: { eligible: Number(eligible?.n ?? 0), resolved: Number(resolved?.n ?? 0) },
    cron: await loadCronStatus(db, now),
    countersAvailable,
  };
}
