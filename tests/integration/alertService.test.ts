import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { moderationEvents } from "@/db/schema";
import { ALERTS } from "@/lib/config/constants";
import { createCounters, createMemoryCounters, type Counters } from "@/lib/metrics/counters";
import { runHealthCheck, type AlertDeps } from "@/lib/services/alertService";
import { createFixtures } from "../helpers/fixtures";
import { createRecordingMailer, throwingMailer } from "../helpers/email";
import { createTestDb, type TestDb } from "../helpers/db";

// N10 Task 5 (AC-1006): the alert check against the in-memory database, in-process counters and a recording mailer.

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const NOW = new Date("2026-11-18T12:30:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const TO = "ops@example.test";
const BASE = "https://court.example.test";

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
  await t.sql("truncate moderation_events, cron_runs, alert_log");
  await t.sql("set role app_server");
});

const deps = (over: Partial<AlertDeps> = {}): AlertDeps => ({ counters: null, mailer: createRecordingMailer(), to: TO, baseUrl: BASE, now: NOW, ...over });

async function events(count: number, flagged: number, at = NOW.getTime() - 10 * MIN) {
  const rows = Array.from({ length: count }, (_unused, index) => ({
    targetType: "case" as const,
    check: "injection" as const,
    result: index < flagged ? ("flag" as const) : ("pass" as const),
    createdAt: new Date(at),
  }));
  await t.db.insert(moderationEvents).values(rows);
}

async function insertRun(route: string, finishedAt: Date, ok = true) {
  await t.sql("reset role");
  await t.sql("insert into cron_runs (route, started_at, finished_at, ok) values ($1, $2, $2, $3)", [route, finishedAt.toISOString(), ok]);
  await t.sql("set role app_server");
}

/** Healthy cron records for every route, so the missed-cron rule has nothing to say. */
async function healthyCron(at = NOW.getTime() - 5 * MIN, skip: string[] = []) {
  for (const route of ["release-reputation", "auto-close", "reminders", "reembed", "rescan", "health-check"]) {
    if (!skip.includes(route)) await insertRun(route, new Date(at));
  }
}

const alerts = () => t.sql("select rule, details, created_at from alert_log order by created_at, id");

function countersWith(requests: number, limited: number, at = NOW.getTime()) {
  let clock = at;
  const counters = createMemoryCounters(() => clock);
  return (async () => {
    for (let index = 0; index < requests; index += 1) await counters.count("requests");
    for (let index = 0; index < limited; index += 1) await counters.count("rate_limited");
    clock = NOW.getTime();
    return counters;
  })();
}

describe("a healthy system", () => {
  it("sends nothing and records nothing", async () => {
    await healthyCron();
    await events(100, 2);
    const mailer = createRecordingMailer();
    const summary = await runHealthCheck(t.db, deps({ mailer, counters: await countersWith(1000, 5) }));
    expect(summary).toEqual({ disabled: false, findings: 0, sent: 0, coolingDown: 0, failed: 0 });
    expect(mailer.messages).toHaveLength(0);
    expect(await alerts()).toHaveLength(0);
  });

  it("fires nothing on a database with no data at all", async () => {
    const mailer = createRecordingMailer();
    expect(await runHealthCheck(t.db, deps({ mailer }))).toMatchObject({ findings: 0, sent: 0 });
  });
});

describe("the flag-rate alert", () => {
  it("sends one email and records the numbers", async () => {
    await healthyCron();
    await events(20, 9);
    const mailer = createRecordingMailer();
    const summary = await runHealthCheck(t.db, deps({ mailer }));
    expect(summary).toEqual({ disabled: false, findings: 1, sent: 1, coolingDown: 0, failed: 0 });
    expect(mailer.messages).toHaveLength(1);
    expect(mailer.messages[0]).toMatchObject({ to: TO, subject: "Agent-Court alert: flag rate is high" });
    expect(mailer.messages[0].text).toContain("9 of 20");
    const [row] = await alerts();
    expect(row.rule).toBe("flag_rate");
    expect(row.details).toEqual({ screened: 20, flagged: 9 });
  });

  it("counts the current hour and the one before it, and no earlier one", async () => {
    await healthyCron();
    await events(20, 9, NOW.getTime() - 40 * MIN); // 11:50, the previous hour
    expect((await runHealthCheck(t.db, deps())).findings).toBe(1);
    await t.sql("reset role");
    await t.sql("truncate moderation_events, alert_log");
    await t.sql("set role app_server");
    await events(20, 9, NOW.getTime() - 100 * MIN); // 10:50, two hours back
    expect((await runHealthCheck(t.db, deps())).findings).toBe(0);
  });

  it("ignores events that are not injection checks", async () => {
    await healthyCron();
    await t.db.insert(moderationEvents).values(Array.from({ length: 30 }, () => ({ targetType: "case" as const, check: "redaction" as const, result: "block" as const, createdAt: new Date(NOW.getTime() - 5 * MIN) })));
    expect((await runHealthCheck(t.db, deps())).findings).toBe(0);
  });
});

describe("the 429 alert", () => {
  it("fires from the counters", async () => {
    await healthyCron();
    const mailer = createRecordingMailer();
    const summary = await runHealthCheck(t.db, deps({ mailer, counters: await countersWith(400, 120) }));
    expect(summary.sent).toBe(1);
    expect(mailer.messages[0].subject).toBe("Agent-Court alert: many requests are being refused with 429");
    expect(mailer.messages[0].text).toContain("120 of 400");
  });

  it("is skipped when the counters cannot be read", async () => {
    await healthyCron();
    const broken: Counters = createCounters({ incr: async () => undefined, mget: async () => { throw new Error("redis down"); } });
    expect((await runHealthCheck(t.db, deps({ counters: broken }))).findings).toBe(0);
  });

  it("does not count requests from before the previous hour", async () => {
    await healthyCron();
    const old = await countersWith(400, 120, NOW.getTime() - 3 * HOUR);
    expect((await runHealthCheck(t.db, deps({ counters: old }))).findings).toBe(0);
  });
});

describe("the missed-cron alert", () => {
  it("fires for a route that has stopped, and names it", async () => {
    await healthyCron(NOW.getTime() - 5 * MIN, ["reminders"]);
    await insertRun("reminders", new Date(NOW.getTime() - 3 * HOUR));
    const mailer = createRecordingMailer();
    const summary = await runHealthCheck(t.db, deps({ mailer }));
    expect(summary.sent).toBe(1);
    expect(mailer.messages[0].subject).toBe("Agent-Court alert: a scheduled route has stopped");
    expect(mailer.messages[0].text).toContain("reminders");
  });

  it("fires for a route that has never run once monitoring is old enough", async () => {
    for (const route of ["release-reputation", "auto-close", "reminders", "reembed", "health-check"]) await insertRun(route, new Date(NOW.getTime() - 5 * MIN));
    await insertRun("health-check", new Date(NOW.getTime() - 3 * 24 * 60 * MIN)); // monitoring began three days ago
    const mailer = createRecordingMailer();
    await runHealthCheck(t.db, deps({ mailer }));
    expect(mailer.messages[0].text).toContain("rescan");
  });
});

describe("the cool-down", () => {
  it("sends the same rule once inside an hour", async () => {
    await healthyCron();
    await events(20, 9);
    const mailer = createRecordingMailer();
    expect((await runHealthCheck(t.db, deps({ mailer }))).sent).toBe(1);
    const later = new Date(NOW.getTime() + 30 * MIN);
    await healthyCron(later.getTime() - 2 * MIN);
    const again = await runHealthCheck(t.db, deps({ mailer, now: later }));
    expect(again).toMatchObject({ findings: 1, sent: 0, coolingDown: 1 });
    expect(mailer.messages).toHaveLength(1);
    expect(await alerts()).toHaveLength(1);
  });

  it("sends again once the cool-down has passed", async () => {
    await healthyCron();
    await events(20, 9);
    const mailer = createRecordingMailer();
    await runHealthCheck(t.db, deps({ mailer }));
    const later = new Date(NOW.getTime() + ALERTS.cooldownMinutes * MIN);
    await healthyCron(later.getTime() - 2 * MIN);
    const again = await runHealthCheck(t.db, deps({ mailer, now: later }));
    expect(again.sent).toBe(1);
    expect(mailer.messages).toHaveLength(2);
  });

  it("is kept for each rule on its own", async () => {
    await healthyCron();
    await events(20, 9);
    const mailer = createRecordingMailer();
    await runHealthCheck(t.db, deps({ mailer }));
    const later = new Date(NOW.getTime() + 10 * MIN);
    await healthyCron(later.getTime() - 2 * MIN);
    const summary = await runHealthCheck(t.db, deps({ mailer, counters: await countersWith(400, 120, later.getTime()), now: later }));
    expect(summary).toMatchObject({ findings: 2, sent: 1, coolingDown: 1 });
  });
});

describe("when the mail cannot be sent", () => {
  it("counts the failure, records nothing, and tries again at the next run", async () => {
    await healthyCron();
    await events(20, 9);
    const mailer = createRecordingMailer();
    mailer.failNext();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = await runHealthCheck(t.db, deps({ mailer }));
    expect(first).toMatchObject({ sent: 0, failed: 1 });
    expect(await alerts()).toHaveLength(0);
    const second = await runHealthCheck(t.db, deps({ mailer }));
    expect(second).toMatchObject({ sent: 1, failed: 0 });
  });

  it("logs the class of the failure and nothing from its message", async () => {
    await healthyCron();
    await events(20, 9);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runHealthCheck(t.db, deps({ mailer: throwingMailer }));
    const text = warn.mock.calls.flat().join("\n");
    warn.mockRestore();
    expect(text).toContain("alert email failed");
    expect(text).not.toContain("SENTINEL_FAILURE_TEXT");
  });
});

describe("when alerting is not set up", () => {
  it.each([
    ["no mail provider", { mailer: null }],
    ["no alert address", { to: null }],
    ["no site address", { baseUrl: null }],
  ])("says disabled with %s, still counts the findings, and records nothing", async (_label, over) => {
    await healthyCron();
    await events(20, 9);
    const summary = await runHealthCheck(t.db, deps(over as Partial<AlertDeps>));
    expect(summary).toEqual({ disabled: true, findings: 1, sent: 0, coolingDown: 0, failed: 0 });
    expect(await alerts()).toHaveLength(0);
  });
});

describe("what an alert holds", () => {
  it("is numbers, rule names and route names: a case written by an agent never reaches it", async () => {
    await healthyCron();
    const { agent } = await f.makeAgent();
    await f.insertCase(agent.id, { title: "SECRET-TITLE-MARKER", summary: "SECRET-SUMMARY-MARKER" });
    await events(20, 9);
    const mailer = createRecordingMailer();
    await runHealthCheck(t.db, deps({ mailer }));
    const everything = JSON.stringify([mailer.messages, await alerts()]);
    expect(everything).not.toContain("SECRET-");
  });
});
