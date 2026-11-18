import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { moderationEvents, verdicts } from "@/db/schema";
import { OPS } from "@/lib/config/constants";
import { createCounters, createMemoryCounters, createMemoryStore, type Counters } from "@/lib/metrics/counters";
import { cronStateOf, loadCronStatus, loadMetrics } from "@/lib/services/metricsService";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

// N10 Task 4 (AC-1005): the numbers behind /admin/metrics, from the in-memory database and in-process counters.

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const NOW = new Date("2026-11-18T12:30:00.000Z");
const at = (iso: string) => new Date(iso);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

beforeEach(async () => {
  await t.sql("reset role");
  await t.sql("truncate cases, moderation_events, cron_runs, verdicts cascade");
  await t.sql("set role app_server");
});

async function insertCase(createdAt: Date, over: Record<string, unknown> = {}) {
  const { agent } = await f.makeAgent();
  return f.insertCase(agent.id, { createdAt, ...over } as never);
}

async function insertVerdict(createdAt: Date, decidedBy: "operator" | "imported" = "operator") {
  const { agent } = await f.makeAgent();
  const c = await f.insertCase(agent.id, { status: "resolved", createdAt });
  const arg = await f.insertArgument(c.id, (await f.makeAgent()).agent.id, "won");
  await t.db.insert(verdicts).values({ caseId: c.id, winningArgumentId: arg.id, decidedBy, verificationLevel: decidedBy === "imported" ? "imported" : "operator_confirmed", createdAt });
}

async function insertEvent(createdAt: Date, result: "pass" | "flag" | "block", check: "injection" | "redaction" | "manual" = "injection") {
  await t.db.insert(moderationEvents).values({ targetType: "case", check, result, createdAt });
}

async function insertRun(route: string, finishedAt: Date, ok: boolean) {
  await t.sql("reset role");
  await t.sql("insert into cron_runs (route, started_at, finished_at, ok) values ($1, $2, $2, $3)", [route, finishedAt.toISOString(), ok]);
  await t.sql("set role app_server");
}

const dayOf = (view: Awaited<ReturnType<typeof loadMetrics>>, day: string) => view.days.find((row) => row.day === day)!;
const hourOf = (view: Awaited<ReturnType<typeof loadMetrics>>, hour: string) => view.hours.find((row) => row.hour === hour)!;

describe("loadMetrics on an empty database", () => {
  it("gives zeros, seven days and twenty-four hours, and no errors", async () => {
    const view = await loadMetrics(t.db, null, NOW);
    expect(view.days.map((row) => row.day)).toEqual(["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18"]);
    expect(view.hours).toHaveLength(24);
    expect(view.hours[0].hour).toBe("2026-11-17 13");
    expect(view.hours[23].hour).toBe("2026-11-18 12");
    for (const day of view.days) expect(day).toMatchObject({ cases: 0, importedCases: 0, verdicts: 0, screened: 0, flagged: 0 });
    expect(view.resolution).toEqual({ eligible: 0, resolved: 0 });
    expect(view.generatedAt).toEqual(NOW);
  });

  it("shows request columns as unknown, not zero, when there are no counters", async () => {
    const view = await loadMetrics(t.db, null, NOW);
    expect(view.countersAvailable).toBe(false);
    for (const day of view.days) expect([day.requests, day.rateLimited]).toEqual([null, null]);
    for (const hour of view.hours) expect([hour.requests, hour.rateLimited]).toEqual([null, null]);
  });

  it("lists every scheduled route as never run", async () => {
    const view = await loadMetrics(t.db, null, NOW);
    expect(view.cron.map((row) => row.route)).toEqual(Object.keys(OPS.cronJobs));
    for (const row of view.cron) expect(row).toMatchObject({ state: "never", lastRunAt: null, lastOkAt: null });
  });
});

describe("cases and verdicts per day", () => {
  it("counts cases by UTC day, with imported cases on their own line", async () => {
    await insertCase(at("2026-11-18T01:00:00Z"));
    await insertCase(at("2026-11-18T11:00:00Z"));
    await insertCase(at("2026-11-17T23:59:59Z"));
    await insertCase(at("2026-11-18T02:00:00Z"), { source: "imported", sourceUrl: "https://github.com/o/r/issues/1", sourceLicense: "MIT" });
    const view = await loadMetrics(t.db, null, NOW);
    expect(dayOf(view, "2026-11-18")).toMatchObject({ cases: 2, importedCases: 1 });
    expect(dayOf(view, "2026-11-17")).toMatchObject({ cases: 1, importedCases: 0 });
  });

  it("leaves out cases older than the seven days and cases in the future", async () => {
    await insertCase(at("2026-11-11T23:00:00Z"));
    await insertCase(at("2026-11-18T13:00:00Z"));
    const view = await loadMetrics(t.db, null, NOW);
    expect(view.days.reduce((sum, row) => sum + row.cases, 0)).toBe(0);
  });

  it("counts verdicts by day and leaves out imported ones", async () => {
    await insertVerdict(at("2026-11-18T03:00:00Z"));
    await insertVerdict(at("2026-11-18T04:00:00Z"));
    await insertVerdict(at("2026-11-16T04:00:00Z"));
    await insertVerdict(at("2026-11-18T05:00:00Z"), "imported");
    const view = await loadMetrics(t.db, null, NOW);
    expect(dayOf(view, "2026-11-18").verdicts).toBe(2);
    expect(dayOf(view, "2026-11-16").verdicts).toBe(1);
  });
});

describe("the flag rate", () => {
  it("counts injection checks per day and per hour, with flag and block as flagged", async () => {
    await insertEvent(at("2026-11-18T12:05:00Z"), "pass");
    await insertEvent(at("2026-11-18T12:10:00Z"), "pass");
    await insertEvent(at("2026-11-18T12:15:00Z"), "flag");
    await insertEvent(at("2026-11-18T12:20:00Z"), "block");
    await insertEvent(at("2026-11-18T08:00:00Z"), "pass");
    await insertEvent(at("2026-11-17T20:00:00Z"), "flag");
    const view = await loadMetrics(t.db, null, NOW);
    expect(hourOf(view, "2026-11-18 12")).toMatchObject({ screened: 4, flagged: 2 });
    expect(hourOf(view, "2026-11-18 08")).toMatchObject({ screened: 1, flagged: 0 });
    expect(dayOf(view, "2026-11-18")).toMatchObject({ screened: 5, flagged: 2 });
    expect(dayOf(view, "2026-11-17")).toMatchObject({ screened: 1, flagged: 1 });
  });

  it("ignores every check that is not the injection check", async () => {
    await insertEvent(at("2026-11-18T12:05:00Z"), "block", "redaction");
    await insertEvent(at("2026-11-18T12:06:00Z"), "block", "manual");
    const view = await loadMetrics(t.db, null, NOW);
    expect(hourOf(view, "2026-11-18 12")).toMatchObject({ screened: 0, flagged: 0 });
  });

  it("leaves out an hour that is more than a day back from the hour table, but keeps it in its day", async () => {
    await insertEvent(at("2026-11-17T12:00:00Z"), "flag");
    const view = await loadMetrics(t.db, null, NOW);
    expect(view.hours.some((row) => row.flagged > 0)).toBe(false);
    expect(dayOf(view, "2026-11-17").flagged).toBe(1);
  });
});

describe("the share of cases that get a verdict", () => {
  it("counts public cases filed by agents and older than seven days, and the ones that are resolved", async () => {
    await insertCase(at("2026-11-01T00:00:00Z"), { status: "open" });
    await insertCase(at("2026-11-02T00:00:00Z"), { status: "resolved" });
    await insertCase(at("2026-11-03T00:00:00Z"), { status: "under_appeal" });
    await insertCase(at("2026-11-04T00:00:00Z"), { status: "held" });
    await insertCase(at("2026-11-05T00:00:00Z"), { status: "withdrawn" });
    await insertCase(at("2026-11-17T00:00:00Z"), { status: "resolved" });
    await insertCase(at("2026-11-02T00:00:00Z"), { status: "resolved", source: "imported", sourceUrl: "https://github.com/o/r/issues/2", sourceLicense: "MIT" });
    const view = await loadMetrics(t.db, null, NOW);
    expect(view.resolution).toEqual({ eligible: 3, resolved: 2 });
  });
});

describe("the request counters", () => {
  function seeded() {
    let clock = NOW.getTime();
    const counters = createMemoryCounters(() => clock);
    return { counters, setClock: (value: number) => (clock = value) };
  }

  it("adds the hours to their days, and shows the last twenty-four hours one by one", async () => {
    const { counters, setClock } = seeded();
    setClock(NOW.getTime());
    await counters.count("requests");
    await counters.count("requests");
    await counters.count("rate_limited");
    setClock(NOW.getTime() - 2 * HOUR); // 10:30
    await counters.count("requests");
    setClock(NOW.getTime() - DAY); // yesterday 12:30
    await counters.count("requests");
    await counters.count("rate_limited");
    setClock(NOW.getTime());
    const view = await loadMetrics(t.db, counters, NOW);
    expect(view.countersAvailable).toBe(true);
    expect(hourOf(view, "2026-11-18 12")).toMatchObject({ requests: 2, rateLimited: 1 });
    expect(hourOf(view, "2026-11-18 10")).toMatchObject({ requests: 1, rateLimited: 0 });
    expect(dayOf(view, "2026-11-18")).toMatchObject({ requests: 3, rateLimited: 1 });
    expect(dayOf(view, "2026-11-17")).toMatchObject({ requests: 1, rateLimited: 1 });
    expect(dayOf(view, "2026-11-12")).toMatchObject({ requests: 0, rateLimited: 0 });
  });

  it("says unknown when the store fails", async () => {
    const failing: Counters = createCounters({
      incr: async () => undefined,
      mget: async () => {
        throw new Error("redis down");
      },
    });
    const view = await loadMetrics(t.db, failing, NOW);
    expect(view.countersAvailable).toBe(false);
    expect(view.days[6].requests).toBeNull();
    expect(view.hours[23].rateLimited).toBeNull();
  });

  it("works with a store that is the in-process one", async () => {
    const counters = createCounters(createMemoryStore(() => NOW.getTime()), () => NOW.getTime());
    expect((await loadMetrics(t.db, counters, NOW)).countersAvailable).toBe(true);
  });
});

describe("the scheduled routes", () => {
  it("is ok after a recent success", async () => {
    await insertRun("reminders", new Date(NOW.getTime() - 30 * MIN), true);
    const row = (await loadCronStatus(t.db, NOW)).find((entry) => entry.route === "reminders")!;
    expect(row.state).toBe("ok");
    expect(row.lastRunAt).toEqual(new Date(NOW.getTime() - 30 * MIN));
    expect(row.lastOkAt).toEqual(new Date(NOW.getTime() - 30 * MIN));
  });

  it("is overdue when the last success is older than twice the gap", async () => {
    await insertRun("reminders", new Date(NOW.getTime() - 121 * MIN), true);
    expect((await loadCronStatus(t.db, NOW)).find((entry) => entry.route === "reminders")!.state).toBe("overdue");
    await insertRun("rescan", new Date(NOW.getTime() - 119 * MIN), true);
    expect((await loadCronStatus(t.db, NOW)).find((entry) => entry.route === "rescan")!.state).toBe("ok");
  });

  it("is failed when the newest run failed, and keeps the time of the last success", async () => {
    await insertRun("reembed", new Date(NOW.getTime() - 20 * MIN), true);
    await insertRun("reembed", new Date(NOW.getTime() - 5 * MIN), false);
    const row = (await loadCronStatus(t.db, NOW)).find((entry) => entry.route === "reembed")!;
    expect(row.state).toBe("failed");
    expect(row.lastOkAt).toEqual(new Date(NOW.getTime() - 20 * MIN));
    expect(row.lastRunAt).toEqual(new Date(NOW.getTime() - 5 * MIN));
  });

  it("is failed when it has only ever failed", async () => {
    await insertRun("auto-close", new Date(NOW.getTime() - 5 * MIN), false);
    const row = (await loadCronStatus(t.db, NOW)).find((entry) => entry.route === "auto-close")!;
    expect(row).toMatchObject({ state: "failed", lastOkAt: null });
  });

  it("is ok again after a success that follows a failure", async () => {
    await insertRun("reembed", new Date(NOW.getTime() - 10 * MIN), false);
    await insertRun("reembed", new Date(NOW.getTime() - 5 * MIN), true);
    expect((await loadCronStatus(t.db, NOW)).find((entry) => entry.route === "reembed")!.state).toBe("ok");
  });

  it("ignores a route that is not on the list", async () => {
    await insertRun("something-else", new Date(NOW.getTime() - 5 * MIN), true);
    expect((await loadCronStatus(t.db, NOW)).map((entry) => entry.route)).toEqual(Object.keys(OPS.cronJobs));
  });
});

describe("cronStateOf", () => {
  const base = { now: NOW, expectedMinutes: 60, lastRunAt: new Date(NOW.getTime() - 10 * MIN), lastRunOk: true, lastOkAt: new Date(NOW.getTime() - 10 * MIN) };

  it.each([
    ["never run", { lastRunAt: null, lastRunOk: null, lastOkAt: null }, "never"],
    ["only failures", { lastOkAt: null, lastRunOk: false }, "failed"],
    ["a recent success", {}, "ok"],
    ["exactly twice the gap", { lastOkAt: new Date(NOW.getTime() - 120 * MIN) }, "ok"],
    ["a minute past twice the gap", { lastOkAt: new Date(NOW.getTime() - 121 * MIN) }, "overdue"],
    ["a recent failure after an old success", { lastRunOk: false, lastOkAt: new Date(NOW.getTime() - 30 * MIN) }, "failed"],
    ["stale and failing", { lastRunOk: false, lastOkAt: new Date(NOW.getTime() - 500 * MIN) }, "overdue"],
  ])("%s", (_label, over, expected) => {
    expect(cronStateOf({ ...base, ...over } as never)).toBe(expected);
  });
});

describe("what the view holds", () => {
  it("is numbers, dates, route names and fixed words only", async () => {
    await insertCase(at("2026-11-18T01:00:00Z"), { title: "SECRET-TITLE-MARKER", summary: "SECRET-SUMMARY-MARKER" });
    await insertRun("reminders", new Date(NOW.getTime() - 30 * MIN), true);
    const text = JSON.stringify(await loadMetrics(t.db, null, NOW));
    expect(text).not.toContain("SECRET-");
  });

});
