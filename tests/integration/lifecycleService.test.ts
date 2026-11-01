import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NewCase } from "@/db/schema";
import { closeIdleCases } from "@/lib/services/lifecycleService";
import { issueVerdict } from "@/lib/services/verdictService";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const NOW = new Date("2026-11-20T12:00:00.000Z");
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
  await t.sql("truncate cases cascade");
  await t.sql("set role app_server");
});

type Status = NonNullable<NewCase["status"]>;

async function publishedCase(daysAgo: number, status: Status = "open", over: Record<string, unknown> = {}) {
  const filer = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { status, publishedAt: new Date(NOW.getTime() - daysAgo * DAY), ...over });
  return { c, filer };
}

const statusOf = async (id: string) => (await t.sql(`select status from cases where id = $1`, [id]))[0].status as string;
const close = (limit = 100, at: Date = NOW) => closeIdleCases(t.db, at, { limit });

describe("closeIdleCases: which cases close", () => {
  it("closes a case published exactly 14 days ago and leaves one published a moment later", async () => {
    const old = await publishedCase(14);
    const recent = await publishedCase(14, "open", { publishedAt: new Date(NOW.getTime() - 14 * DAY + 1) });
    expect(await close()).toEqual({ closed: 1, remaining: 0 });
    expect(await statusOf(old.c.id)).toBe("closed_unresolved");
    expect(await statusOf(recent.c.id)).toBe("open");
  });

  it.each(["open", "argued"] as const)("closes an idle %s case", async (status) => {
    const s = await publishedCase(20, status);
    await close();
    expect(await statusOf(s.c.id)).toBe("closed_unresolved");
  });

  it.each(["held", "resolved", "under_appeal", "withdrawn", "rejected", "closed_unresolved"] as const)("never touches a %s case, however old", async (status) => {
    const s = await publishedCase(60, status);
    expect(await close()).toEqual({ closed: 0, remaining: 0 });
    expect(await statusOf(s.c.id)).toBe(status);
  });

  it("never closes a case that has a verdict, even one left open by mistake", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open", publishedAt: new Date(NOW.getTime() - 30 * DAY) });
    const winner = await f.makeAgent();
    const argument = await f.insertArgument(c.id, winner.actor.agentId, "active");
    f.unwrap(await issueVerdict(t.db, passGate, filer.operator, { caseId: c.id, winningArgumentId: argument.id }, new Date(NOW.getTime() - 20 * DAY)));
    await t.sql(`update cases set status = 'open' where id = $1`, [c.id]);
    expect(await close()).toEqual({ closed: 0, remaining: 0 });
    expect(await statusOf(c.id)).toBe("open");
  });

  it("leaves the arguments of a closed case alone", async () => {
    const s = await publishedCase(20, "argued");
    const author = await f.makeAgent();
    const argument = await f.insertArgument(s.c.id, author.actor.agentId, "active");
    await close();
    expect((await t.sql(`select status from arguments where id = $1`, [argument.id]))[0].status).toBe("active");
  });
});

describe("closeIdleCases: batches and repeats", () => {
  it("closes the oldest first, up to the limit, and says how many are left", async () => {
    const cases = [];
    for (const days of [15, 40, 20, 30, 16]) cases.push(await publishedCase(days));
    expect(await close(2)).toEqual({ closed: 2, remaining: 3 });
    expect(await statusOf(cases[1].c.id)).toBe("closed_unresolved"); // 40 days
    expect(await statusOf(cases[3].c.id)).toBe("closed_unresolved"); // 30 days
    expect(await statusOf(cases[0].c.id)).toBe("open");
    expect(await close(100)).toEqual({ closed: 3, remaining: 0 });
  });

  it("does nothing the second time", async () => {
    await publishedCase(20);
    expect((await close()).closed).toBe(1);
    expect(await close()).toEqual({ closed: 0, remaining: 0 });
  });

  it("closes each case once when two runs overlap", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await publishedCase(20 + i)).c.id);
    const [a, b] = await Promise.all([close(), close()]);
    expect(a.closed + b.closed).toBe(3);
    for (const id of ids) expect(await f.count("audit_log where action = 'case.closed' and target = $1", [id])).toBe(1);
  });

  it("answers zero for a limit of zero, a negative limit or nonsense, closing nothing", async () => {
    const s = await publishedCase(20);
    for (const limit of [0, -5, Number.NaN]) expect(await close(limit)).toMatchObject({ closed: 0 });
    expect(await statusOf(s.c.id)).toBe("open");
  });
});

describe("closeIdleCases: the record", () => {
  it("writes one audit row per case, from the system, with the case id and nothing else", async () => {
    const s = await publishedCase(20);
    await close();
    const rows = await t.sql(`select actor_type, actor_id, target, metadata from audit_log where action = 'case.closed' and target = $1`, [s.c.id]);
    expect(rows).toEqual([{ actor_type: "system", actor_id: null, target: s.c.id, metadata: {} }]);
  });
});

describe("closeIdleCases: against a verdict at the same time", () => {
  it("ends with the case either resolved with its verdict or closed with none, never both", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "argued", publishedAt: new Date(NOW.getTime() - 20 * DAY) });
    const winner = await f.makeAgent();
    const argument = await f.insertArgument(c.id, winner.actor.agentId, "active");
    await Promise.all([close(), issueVerdict(t.db, passGate, filer.operator, { caseId: c.id, winningArgumentId: argument.id }, NOW)]);
    const status = await statusOf(c.id);
    const verdicts = await f.count("verdicts where case_id = $1", [c.id]);
    expect(["resolved", "closed_unresolved"]).toContain(status);
    expect(verdicts).toBe(status === "resolved" ? 1 : 0);
  });
});
