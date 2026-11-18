import { describe, expect, it } from "vitest";
import { evaluateAlerts, type AlertInput } from "@/lib/alerts/rules";
import { ALERTS } from "@/lib/config/constants";

// N10 Task 5 (AC-1006): which alerts fire for which numbers.

const NOW = new Date("2026-11-18T12:30:00.000Z");
const MIN = 60_000;
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN);

const healthy = (over: Partial<AlertInput> = {}): AlertInput => ({
  now: NOW,
  flag: { screened: 100, flagged: 2 },
  requests: { requests: 1000, rateLimited: 5 },
  cron: [
    { route: "reminders", expectedMinutes: 60, lastOkAt: ago(20) },
    { route: "reembed", expectedMinutes: 15, lastOkAt: ago(5) },
  ],
  monitoringSince: ago(60 * 24 * 30),
  ...over,
});

describe("the thresholds", () => {
  it("are the ones the spec names", () => {
    expect(ALERTS).toMatchObject({ flagMinScreened: 20, flagMinShare: 0.3, rateMinRequests: 100, rateMinShare: 0.2, cooldownMinutes: 60, missedFactor: 2 });
  });
});

describe("healthy numbers", () => {
  it("fire nothing", () => {
    expect(evaluateAlerts(healthy())).toEqual([]);
  });

  it("fire nothing when there is no traffic at all", () => {
    expect(evaluateAlerts(healthy({ flag: { screened: 0, flagged: 0 }, requests: { requests: 0, rateLimited: 0 } }))).toEqual([]);
  });
});

describe("the flag-rate rule", () => {
  it("fires at 20 screened and 30 percent flagged", () => {
    expect(evaluateAlerts(healthy({ flag: { screened: 20, flagged: 6 } }))).toEqual([{ rule: "flag_rate", screened: 20, flagged: 6 }]);
  });

  it("fires on more than that", () => {
    expect(evaluateAlerts(healthy({ flag: { screened: 200, flagged: 150 } }))).toEqual([{ rule: "flag_rate", screened: 200, flagged: 150 }]);
  });

  it("stays quiet just under the share", () => {
    expect(evaluateAlerts(healthy({ flag: { screened: 20, flagged: 5 } }))).toEqual([]);
  });

  it("stays quiet when too few texts were screened, however many were flagged", () => {
    expect(evaluateAlerts(healthy({ flag: { screened: 19, flagged: 19 } }))).toEqual([]);
    expect(evaluateAlerts(healthy({ flag: { screened: 5, flagged: 5 } }))).toEqual([]);
  });
});

describe("the 429 rule", () => {
  it("fires at 100 requests and 20 percent answered 429", () => {
    expect(evaluateAlerts(healthy({ requests: { requests: 100, rateLimited: 20 } }))).toEqual([{ rule: "rate_limited", requests: 100, rateLimited: 20 }]);
  });

  it("stays quiet just under the share", () => {
    expect(evaluateAlerts(healthy({ requests: { requests: 100, rateLimited: 19 } }))).toEqual([]);
  });

  it("stays quiet when there were too few requests", () => {
    expect(evaluateAlerts(healthy({ requests: { requests: 99, rateLimited: 99 } }))).toEqual([]);
  });

  it("is skipped when the counters are unknown: an unknown is not an alert", () => {
    expect(evaluateAlerts(healthy({ requests: null }))).toEqual([]);
  });
});

describe("the missed-cron rule", () => {
  it("fires for a route with no success within twice its gap", () => {
    const findings = evaluateAlerts(healthy({ cron: [{ route: "reminders", expectedMinutes: 60, lastOkAt: ago(121) }] }));
    expect(findings).toEqual([{ rule: "cron_missed", routes: ["reminders"] }]);
  });

  it("stays quiet at exactly twice the gap", () => {
    expect(evaluateAlerts(healthy({ cron: [{ route: "reminders", expectedMinutes: 60, lastOkAt: ago(120) }] }))).toEqual([]);
  });

  it("names every missed route in one finding, in alphabetical order", () => {
    const findings = evaluateAlerts(
      healthy({
        cron: [
          { route: "rescan", expectedMinutes: 1440, lastOkAt: ago(3000) },
          { route: "auto-close", expectedMinutes: 1440, lastOkAt: ago(5000) },
          { route: "reembed", expectedMinutes: 15, lastOkAt: ago(5) },
        ],
      }),
    );
    expect(findings).toEqual([{ rule: "cron_missed", routes: ["auto-close", "rescan"] }]);
  });

  it("counts a route that has never succeeded as missed once twice its gap has passed since monitoring began", () => {
    const base = { cron: [{ route: "reembed", expectedMinutes: 15, lastOkAt: null }] };
    expect(evaluateAlerts(healthy({ ...base, monitoringSince: ago(31) }))).toEqual([{ rule: "cron_missed", routes: ["reembed"] }]);
    expect(evaluateAlerts(healthy({ ...base, monitoringSince: ago(29) }))).toEqual([]);
  });

  it("does not report a never-run route when nothing has been recorded at all", () => {
    expect(evaluateAlerts(healthy({ cron: [{ route: "reembed", expectedMinutes: 15, lastOkAt: null }], monitoringSince: null }))).toEqual([]);
  });
});

describe("several rules at once", () => {
  it("come back in a fixed order: flag rate, 429 rate, missed cron", () => {
    const findings = evaluateAlerts(
      healthy({
        flag: { screened: 50, flagged: 40 },
        requests: { requests: 500, rateLimited: 300 },
        cron: [{ route: "reminders", expectedMinutes: 60, lastOkAt: ago(500) }],
      }),
    );
    expect(findings.map((finding) => finding.rule)).toEqual(["flag_rate", "rate_limited", "cron_missed"]);
  });
});
