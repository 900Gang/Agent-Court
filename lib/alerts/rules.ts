import { ALERTS } from "@/lib/config/constants";

// The three alert rules, as pure functions of numbers (N10, AC-1006). They decide what is wrong. The alert service
// decides whether to say so (cool-down) and sends the email. Nothing here reads a database or holds any text.

export type AlertRule = "flag_rate" | "rate_limited" | "cron_missed";

export type AlertFinding =
  | { rule: "flag_rate"; screened: number; flagged: number }
  | { rule: "rate_limited"; requests: number; rateLimited: number }
  /** The routes that have missed their runs, in alphabetical order. */
  | { rule: "cron_missed"; routes: string[] };

export type AlertInput = {
  now: Date;
  /** Injection checks in the window, and how many of them flagged or blocked. */
  flag: { screened: number; flagged: number };
  /** Authenticated requests and 429s in the window. Null when the counters could not be read: the rule is then skipped. */
  requests: { requests: number; rateLimited: number } | null;
  /** The scheduled routes with their normal gap in minutes and the time of their last success, if any. */
  cron: Array<{ route: string; expectedMinutes: number; lastOkAt: Date | null }>;
  /**
   * When monitoring began: the time of the oldest run on record, or null when there is none. A route that has never
   * succeeded counts as missed only once twice its gap has passed since then.
   */
  monitoringSince: Date | null;
};

/** The rules that fire for these numbers, in a fixed order. Nothing fires on healthy numbers or too little traffic. */
export function evaluateAlerts(input: AlertInput): AlertFinding[] {
  const findings: AlertFinding[] = [];

  const { screened, flagged } = input.flag;
  if (screened >= ALERTS.flagMinScreened && flagged / screened >= ALERTS.flagMinShare) {
    findings.push({ rule: "flag_rate", screened, flagged });
  }

  if (input.requests) {
    const { requests, rateLimited } = input.requests;
    if (requests >= ALERTS.rateMinRequests && rateLimited / requests >= ALERTS.rateMinShare) {
      findings.push({ rule: "rate_limited", requests, rateLimited });
    }
  }

  const missed = input.cron
    .filter((job) => {
      const limit = ALERTS.missedFactor * job.expectedMinutes * 60_000;
      if (job.lastOkAt) return input.now.getTime() - job.lastOkAt.getTime() > limit;
      return input.monitoringSince !== null && input.now.getTime() - input.monitoringSince.getTime() > limit;
    })
    .map((job) => job.route)
    .sort();
  if (missed.length > 0) findings.push({ rule: "cron_missed", routes: missed });

  return findings;
}
