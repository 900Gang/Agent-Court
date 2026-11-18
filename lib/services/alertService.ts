import { and, count, desc, eq, gte, lte, min } from "drizzle-orm";
import { alertLog, cronRuns, moderationEvents } from "@/db/schema";
import type { Database } from "@/db/types";
import { evaluateAlerts, type AlertFinding, type AlertRule } from "@/lib/alerts/rules";
import { ALERTS } from "@/lib/config/constants";
import { logger } from "@/lib/config/logger";
import { safeErrorFields } from "@/lib/config/safeError";
import { alertMessage } from "@/emails/alert";
import type { EmailProvider } from "@/lib/email/provider";
import type { Counters } from "@/lib/metrics/counters";
import { loadCronStatus } from "./metricsService";

// The alert check (N10, AC-1006): reads the numbers, applies the three rules and emails one message for each rule that
// fires and is not cooling down. Counts and route names only, in the log, the table and the email.

const HOUR_MS = 3_600_000;

export type AlertDeps = {
  /** Where the request counters are. Null: the 429 rule is skipped. */
  counters: Counters | null;
  /** The mail provider. Null: the check runs and sends nothing. */
  mailer: EmailProvider | null;
  /** The alert address. Null: the check runs and sends nothing. */
  to: string | null;
  /** The site's own address, for the link in the email. Null: the check runs and sends nothing. */
  baseUrl: string | null;
  now?: Date;
};

export type AlertSummary = {
  /** True when nothing could be sent because the address, the mail provider or the site address is not set. */
  disabled: boolean;
  /** How many rules fired. */
  findings: number;
  sent: number;
  /** Fired rules that stayed quiet because the same rule was reported within the cool-down. */
  coolingDown: number;
  failed: number;
};

const startOfHour = (at: Date) => new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);

/** The numbers the rules need, for the current clock hour and the one before it. */
async function gather(db: Database, deps: AlertDeps, now: Date) {
  const windowStart = new Date(startOfHour(now).getTime() - HOUR_MS);
  const checks = await db
    .select({ result: moderationEvents.result, n: count() })
    .from(moderationEvents)
    .where(and(eq(moderationEvents.check, "injection"), gte(moderationEvents.createdAt, windowStart), lte(moderationEvents.createdAt, now)))
    .groupBy(moderationEvents.result);
  let screened = 0;
  let flagged = 0;
  for (const row of checks) {
    screened += Number(row.n);
    if (row.result !== "pass") flagged += Number(row.n);
  }

  let requests: { requests: number; rateLimited: number } | null = null;
  if (deps.counters) {
    try {
      const total = (await deps.counters.read("requests", 2)).reduce((sum, value) => sum + value, 0);
      const limited = (await deps.counters.read("rate_limited", 2)).reduce((sum, value) => sum + value, 0);
      requests = { requests: total, rateLimited: limited };
    } catch {
      // The rule is skipped when the numbers are unknown: an unknown is not an alert.
    }
  }

  const cron = (await loadCronStatus(db, now)).map((row) => ({ route: row.route, expectedMinutes: row.expectedMinutes, lastOkAt: row.lastOkAt }));
  const [first] = await db.select({ at: min(cronRuns.finishedAt) }).from(cronRuns);
  return { flag: { screened, flagged }, requests, cron, monitoringSince: first?.at ?? null };
}

const detailsOf = (finding: AlertFinding): Record<string, number | string> => {
  switch (finding.rule) {
    case "flag_rate":
      return { screened: finding.screened, flagged: finding.flagged };
    case "rate_limited":
      return { requests: finding.requests, rateLimited: finding.rateLimited };
    case "cron_missed":
      return { routes: finding.routes.join(",") };
  }
};

async function coolingDown(db: Database, rule: AlertRule, now: Date): Promise<boolean> {
  const [latest] = await db.select({ at: alertLog.createdAt }).from(alertLog).where(eq(alertLog.rule, rule)).orderBy(desc(alertLog.createdAt)).limit(1);
  return latest !== undefined && now.getTime() - latest.at.getTime() < ALERTS.cooldownMinutes * 60_000;
}

/**
 * Runs the check. A rule that fires and is not cooling down is sent, and only after the send succeeds is it recorded in
 * alert_log. A send that fails records nothing, so the next run tries again. (Two runs at the same moment could send
 * twice; the check runs every ten minutes and takes seconds.) With no alert address, mail provider or site address,
 * nothing is sent and nothing is recorded: the summary says `disabled`.
 */
export async function runHealthCheck(db: Database, deps: AlertDeps): Promise<AlertSummary> {
  const now = deps.now ?? new Date();
  const findings = evaluateAlerts({ now, ...(await gather(db, deps, now)) });
  const summary: AlertSummary = { disabled: false, findings: findings.length, sent: 0, coolingDown: 0, failed: 0 };

  const { mailer, to, baseUrl } = deps;
  if (!mailer || !to || !baseUrl) return { ...summary, disabled: true };

  for (const finding of findings) {
    if (await coolingDown(db, finding.rule, now)) {
      summary.coolingDown += 1;
      continue;
    }
    try {
      await mailer.send(alertMessage(finding, baseUrl, to));
    } catch (error) {
      summary.failed += 1;
      logger.warn("alert email failed", { rule: finding.rule, ...safeErrorFields(error) });
      continue;
    }
    summary.sent += 1;
    try {
      await db.insert(alertLog).values({ rule: finding.rule, details: detailsOf(finding), createdAt: now });
    } catch (error) {
      // The mail went out. Without the row the rule may be sent again at the next run, which is better than losing it.
      logger.warn("alert not recorded", { rule: finding.rule, ...safeErrorFields(error) });
    }
  }
  return summary;
}
