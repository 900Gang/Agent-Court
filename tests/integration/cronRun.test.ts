import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OPS } from "@/lib/config/constants";
import { countsOf, runCron } from "@/lib/http/cronRun";
import { createTestDb, type TestDb } from "../helpers/db";

// N10 Task 3 (AC-1005, AC-1006): every scheduled job runs through runCron, which records one row per run.

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

beforeEach(async () => {
  await t.sql("reset role");
  await t.sql("truncate cron_runs");
  await t.sql("set role app_server");
});

const rows = () => t.sql("select * from cron_runs order by finished_at, id");
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 18, 9, 0, 0) + tick++ * 1000);

describe("runCron", () => {
  it("returns the job's summary unchanged and records one successful run with its counts", async () => {
    const summary = { closed: 3, skipped: 1, disabled: false };
    const result = await runCron(t.db, "auto-close", async () => summary, clock);
    expect(result).toBe(summary);
    const [row] = await rows();
    expect(row.route).toBe("auto-close");
    expect(row.ok).toBe(true);
    expect(row.counts).toEqual({ closed: 3, skipped: 1, disabled: false });
    expect(new Date(row.finished_at as string).getTime()).toBeGreaterThan(new Date(row.started_at as string).getTime());
  });

  it("records a failed run with no counts, and throws the very same error again", async () => {
    const boom = new Error("database said no for hunter2hunter2");
    await expect(runCron(t.db, "reminders", async () => { throw boom; }, clock)).rejects.toBe(boom);
    const [row] = await rows();
    expect(row.route).toBe("reminders");
    expect(row.ok).toBe(false);
    expect(row.counts).toEqual({});
    expect(JSON.stringify(row)).not.toContain("hunter2");
  });

  it("makes a new row for every run", async () => {
    await runCron(t.db, "rescan", async () => ({ n: 1 }), clock);
    await runCron(t.db, "rescan", async () => ({ n: 2 }), clock);
    expect(await rows()).toHaveLength(2);
  });

  it("does not turn a good run into a failed one when the record cannot be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = { insert: () => { throw new Error("table is gone hunter2hunter2"); } } as never;
    await expect(runCron(broken, "reembed", async () => ({ ok: 1 }), clock)).resolves.toEqual({ ok: 1 });
    const text = warn.mock.calls.flat().join("\n");
    warn.mockRestore();
    expect(text).toContain("cron run not recorded");
    expect(text).not.toContain("hunter2");
  });

  it("does not hide a failed job when the record cannot be written either", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = { insert: () => { throw new Error("table is gone"); } } as never;
    const boom = new Error("job failed");
    await expect(runCron(broken, "reembed", async () => { throw boom; }, clock)).rejects.toBe(boom);
  });

  it("keeps only the newest rows", async () => {
    await t.sql("reset role");
    await t.sql(
      `insert into cron_runs (route, started_at, finished_at, ok)
       select 'rescan', now() - make_interval(secs => g + 10), now() - make_interval(secs => g + 10), true
       from generate_series(1, ${OPS.scheduledRunsKept + 5}) as g`,
    );
    await t.sql("set role app_server");
    await runCron(t.db, "rescan", async () => ({ n: 1 }), () => new Date());
    const all = await rows();
    expect(all).toHaveLength(OPS.scheduledRunsKept);
    // the run just made is the newest, so it is kept
    expect(all.some((row) => (row.counts as { n?: number }).n === 1)).toBe(true);
  });

  it("is append-only for the application role: an update is refused", async () => {
    await expect(t.sql("update public.cron_runs set ok = false")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("countsOf", () => {
  it("keeps numbers and booleans under plain names", () => {
    expect(countsOf({ closed: 2, disabled: true, ratio: 0.5 })).toEqual({ closed: 2, disabled: true, ratio: 0.5 });
  });

  it.each([
    ["a string", { message: "Bearer abcdefghijklmnop", n: 1 }, { n: 1 }],
    ["a nested object", { inner: { n: 1 }, n: 2 }, { n: 2 }],
    ["an array", { list: [1, 2], n: 2 }, { n: 2 }],
    ["null and undefined", { a: null, b: undefined, n: 3 }, { n: 3 }],
    ["not a number", { a: Number.NaN, b: Number.POSITIVE_INFINITY, n: 4 }, { n: 4 }],
    ["a name that is not plain", { "a b": 1, "9lives": 2, "x-y": 3, n: 5 }, { n: 5 }],
  ])("drops %s", (_label, summary, expected) => {
    expect(countsOf(summary)).toEqual(expected);
  });

  it("keeps at most twenty counts", () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_unused, index) => [`c${index}`, index]));
    expect(Object.keys(countsOf(many))).toHaveLength(20);
  });

  it("gives nothing for something that is not an object", () => {
    for (const value of [null, undefined, 5, "text", [1, 2]]) expect(countsOf(value)).toEqual({});
  });
});
