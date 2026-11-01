import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cases, reputationEvents } from "@/db/schema";
import { getOperatorCasesLimit, getVerdictFormView, listOperatorCases } from "@/lib/services/operatorCaseService";
import { getReputation, getReputationForAgents } from "@/lib/services/reputationService";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
type Made = Awaited<ReturnType<ReturnType<typeof createFixtures>["makeAgent"]>>;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

afterEach(() => vi.restoreAllMocks());

const day = (n: number) => new Date(Date.UTC(2026, 0, n, 12));
const UNKNOWN = "00000000-0000-4000-8000-00000000dead";

/** Gives `agent` one verdict's worth of an event, directly, with the given points and status. */
async function plant(agent: Made, points: number, status: "pending" | "final" | "reversed") {
  const issuer = await f.makeAgent();
  const c = await f.insertCase(issuer.actor.agentId, { status: "resolved" });
  const argument = await f.insertArgument(c.id, agent.actor.agentId, "won");
  const [{ id }] = await t.sql(
    `insert into verdicts (case_id, winning_argument_id, decided_by, decided_by_operator_id, verification_level, status)
     values ($1, $2, 'operator', $3, 'operator_confirmed', 'active') returning id`,
    [c.id, argument.id, issuer.actor.operatorId],
  );
  await t.db.insert(reputationEvents).values({ agentId: agent.actor.agentId, operatorId: agent.actor.operatorId, verdictId: id as string, points, reason: "verdict_win", status });
}

describe("listOperatorCases: which cases", () => {
  it("lists the cases filed by the operator's own agents, all of them, and no one else's", async () => {
    const mine = await f.makeAgent();
    const second = await f.makeAgent(mine.operator);
    const other = await f.makeAgent();
    const a = await f.insertCase(mine.actor.agentId, { title: "MARK_a" });
    const b = await f.insertCase(second.actor.agentId, { title: "MARK_b" });
    await f.insertCase(other.actor.agentId, { title: "MARK_other" });
    const view = await listOperatorCases(t.db, mine.operator.id);
    expect(view.cases.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());
    expect(view.cases.map((row) => row.title).sort()).toEqual(["MARK_a", "MARK_b"]);
  });

  it("shows the title, the filing agent's handle, the state and the date", async () => {
    const mine = await f.makeAgent();
    const c = await f.insertCase(mine.actor.agentId, { title: "Retry loop", status: "open", createdAt: day(5) });
    const [row] = (await listOperatorCases(t.db, mine.operator.id)).cases;
    expect(row).toMatchObject({ id: c.id, title: "Retry loop", status: "open", agentHandle: mine.agent.handle, createdAt: day(5) });
  });

  it.each(["held", "open", "argued", "resolved", "withdrawn"] as const)("includes a %s case of its own", async (status) => {
    const mine = await f.makeAgent();
    const c = await f.insertCase(mine.actor.agentId, { status });
    const view = await listOperatorCases(t.db, mine.operator.id);
    expect(view.cases.find((row) => row.id === c.id)?.status).toBe(status);
  });

  it("puts the newest first", async () => {
    const mine = await f.makeAgent();
    const old = await f.insertCase(mine.actor.agentId, { createdAt: day(1) });
    const newest = await f.insertCase(mine.actor.agentId, { createdAt: day(3) });
    const middle = await f.insertCase(mine.actor.agentId, { createdAt: day(2) });
    expect((await listOperatorCases(t.db, mine.operator.id)).cases.map((row) => row.id)).toEqual([newest.id, middle.id, old.id]);
  });

  it("keeps only the newest cases when there are more than the cap", async () => {
    const mine = await f.makeAgent();
    const limit = getOperatorCasesLimit();
    const total = limit + 2;
    await t.db.insert(cases).values(
      Array.from({ length: total }, (_, i) => ({
        agentId: mine.actor.agentId,
        title: `case-${i}`,
        summary: "S",
        expected: "E",
        actual: "A",
        createdAt: new Date(Date.UTC(2025, 0, 1) + i * 60_000),
      })),
    );
    const titles = (await listOperatorCases(t.db, mine.operator.id)).cases.map((row) => row.title);
    expect(titles).toHaveLength(limit);
    expect(titles[0]).toBe(`case-${total - 1}`);
    expect(titles).not.toContain("case-0");
    expect(titles).not.toContain("case-1");
  });
});

describe("listOperatorCases: arguments", () => {
  it("counts only the active arguments and gives the date of the oldest", async () => {
    const mine = await f.makeAgent();
    const c = await f.insertCase(mine.actor.agentId, { status: "argued" });
    const one = await f.makeAgent();
    const two = await f.makeAgent();
    const three = await f.makeAgent();
    await f.insertArgument(c.id, two.actor.agentId, "active", day(9));
    await f.insertArgument(c.id, one.actor.agentId, "active", day(4));
    await f.insertArgument(c.id, one.actor.agentId, "withdrawn", day(1));
    await f.insertArgument(c.id, three.actor.agentId, "held", day(2));
    const [row] = (await listOperatorCases(t.db, mine.operator.id)).cases;
    expect(row.argumentCount).toBe(2);
    expect(row.oldestArgumentAt).toEqual(day(4));
  });

  it("gives 0 and no date for a case with no active argument", async () => {
    const mine = await f.makeAgent();
    await f.insertCase(mine.actor.agentId, { status: "open" });
    const [row] = (await listOperatorCases(t.db, mine.operator.id)).cases;
    expect(row.argumentCount).toBe(0);
    expect(row.oldestArgumentAt).toBeNull();
  });

  it("counts the arguments of each case separately", async () => {
    const mine = await f.makeAgent();
    const rival = await f.makeAgent();
    const second = await f.makeAgent();
    const busy = await f.insertCase(mine.actor.agentId, { createdAt: day(2) });
    const quiet = await f.insertCase(mine.actor.agentId, { createdAt: day(1) });
    await f.insertArgument(busy.id, rival.actor.agentId, "active");
    await f.insertArgument(busy.id, second.actor.agentId, "active");
    const counts = new Map((await listOperatorCases(t.db, mine.operator.id)).cases.map((row) => [row.id, row.argumentCount]));
    expect(counts.get(busy.id)).toBe(2);
    expect(counts.get(quiet.id)).toBe(0);
  });
});

describe("listOperatorCases: agents and their points", () => {
  it("lists each of the operator's agents with final points, pending points and tier, kept apart", async () => {
    const mine = await f.makeAgent();
    const second = await f.makeAgent(mine.operator);
    await plant(mine, 30, "final");
    await plant(mine, 40, "pending");
    await plant(mine, 100, "reversed");
    const { agents } = await listOperatorCases(t.db, mine.operator.id);
    const byId = new Map(agents.map((row) => [row.id, row]));
    expect(byId.get(mine.agent.id)).toEqual({ id: mine.agent.id, handle: mine.agent.handle, points: 30, pending: 40, tier: 1 });
    expect(byId.get(second.agent.id)).toEqual({ id: second.agent.id, handle: second.agent.handle, points: 0, pending: 0, tier: 0 });
    expect(agents).toHaveLength(2);
  });

  it("does not let pending points raise the tier", async () => {
    const mine = await f.makeAgent();
    await plant(mine, 500, "pending");
    const [row] = (await listOperatorCases(t.db, mine.operator.id)).agents;
    expect(row).toMatchObject({ points: 0, pending: 500, tier: 0 });
  });

  it("leaves out other operators' agents and a deleted agent", async () => {
    const mine = await f.makeAgent();
    const gone = await f.makeAgent(mine.operator);
    const other = await f.makeAgent();
    await plant(other, 30, "final");
    await t.sql("reset role");
    await t.sql(`update agents set deleted_at = now() where id = $1`, [gone.agent.id]);
    await t.sql("set role app_server");
    const { agents } = await listOperatorCases(t.db, mine.operator.id);
    expect(agents.map((row) => row.id)).toEqual([mine.agent.id]);
  });

  it("holds no operator id and no operator field", async () => {
    const mine = await f.makeAgent();
    await f.insertCase(mine.actor.agentId);
    const text = JSON.stringify(await listOperatorCases(t.db, mine.operator.id));
    expect(text).not.toContain(mine.operator.id);
    expect(text).not.toMatch(/operator_?id/i);
  });
});

describe("listOperatorCases: cost and bad input", () => {
  it("sends the same few statements whatever the amount of data", async () => {
    const small = await f.makeAgent();
    await f.insertCase(small.actor.agentId);
    const large = await f.makeAgent();
    const extra = [await f.makeAgent(large.operator), await f.makeAgent(large.operator)];
    for (const agent of [large, ...extra]) for (let i = 0; i < 4; i++) await f.insertCase(agent.actor.agentId);

    const spy = vi.spyOn(t.pg, "query");
    await listOperatorCases(t.db, small.operator.id);
    const smallCount = spy.mock.calls.length;
    spy.mockClear();
    await listOperatorCases(t.db, large.operator.id);
    expect(spy.mock.calls.length).toBe(smallCount);
    expect(smallCount).toBeLessThanOrEqual(4);
  });

  it("answers an empty view for a malformed id and sends no statement", async () => {
    const spy = vi.spyOn(t.pg, "query");
    expect(await listOperatorCases(t.db, "not-a-uuid")).toEqual({ cases: [], agents: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers an empty view for an operator with nothing", async () => {
    const operator = await f.makeOperator();
    expect(await listOperatorCases(t.db, operator.id)).toEqual({ cases: [], agents: [] });
  });
});

describe("getVerdictFormView", () => {
  async function openCase(status: "open" | "argued" = "open") {
    const mine = await f.makeAgent();
    const c = await f.insertCase(mine.actor.agentId, { status, title: "MARK_title" });
    return { mine, c };
  }

  it("gives the title and the active arguments, oldest first, with the author's handle and the text", async () => {
    const { mine, c } = await openCase("argued");
    const a = await f.makeAgent();
    const b = await f.makeAgent();
    const later = await f.insertArgument(c.id, a.actor.agentId, "active", day(8));
    const earlier = await f.insertArgument(c.id, b.actor.agentId, "active", day(3));
    const view = await getVerdictFormView(t.db, mine.operator.id, c.id);
    expect(view).toMatchObject({ caseId: c.id, title: "MARK_title" });
    expect(view?.arguments.map((entry) => entry.id)).toEqual([earlier.id, later.id]);
    expect(view?.arguments[0]).toMatchObject({ authorHandle: b.agent.handle, reasoning: "r", proposedChange: "p" });
  });

  it("leaves out arguments that are not active", async () => {
    const { mine, c } = await openCase();
    const a = await f.makeAgent();
    const b = await f.makeAgent();
    const live = await f.insertArgument(c.id, a.actor.agentId, "active");
    await f.insertArgument(c.id, b.actor.agentId, "held");
    await f.insertArgument(c.id, a.actor.agentId, "withdrawn");
    expect((await getVerdictFormView(t.db, mine.operator.id, c.id))?.arguments.map((entry) => entry.id)).toEqual([live.id]);
  });

  it.each(["open", "argued"] as const)("is available for a %s case", async (status) => {
    const { mine, c } = await openCase(status);
    await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "active");
    expect(await getVerdictFormView(t.db, mine.operator.id, c.id)).not.toBeNull();
  });

  it.each(["held", "resolved", "withdrawn", "under_appeal", "closed_unresolved"] as const)("is null for a %s case", async (status) => {
    const mine = await f.makeAgent();
    const c = await f.insertCase(mine.actor.agentId, { status });
    await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "active");
    expect(await getVerdictFormView(t.db, mine.operator.id, c.id)).toBeNull();
  });

  it("is null for a case with no active argument", async () => {
    const { mine, c } = await openCase();
    expect(await getVerdictFormView(t.db, mine.operator.id, c.id)).toBeNull();
  });

  it("is null for another operator's case, the same as for an unknown case", async () => {
    const { c } = await openCase();
    await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "active");
    const stranger = await f.makeOperator();
    expect(await getVerdictFormView(t.db, stranger.id, c.id)).toBeNull();
    expect(await getVerdictFormView(t.db, stranger.id, UNKNOWN)).toBeNull();
  });

  it("is available for a case filed by a different agent of the same operator", async () => {
    const mine = await f.makeAgent();
    const second = await f.makeAgent(mine.operator);
    const c = await f.insertCase(second.actor.agentId, { status: "open" });
    await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "active");
    expect(await getVerdictFormView(t.db, mine.operator.id, c.id)).not.toBeNull();
  });

  it("is null for a malformed case id or operator id and sends no statement", async () => {
    const { mine, c } = await openCase();
    const spy = vi.spyOn(t.pg, "query");
    expect(await getVerdictFormView(t.db, mine.operator.id, "nope")).toBeNull();
    expect(await getVerdictFormView(t.db, "nope", c.id)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("holds no operator id", async () => {
    const { mine, c } = await openCase();
    await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "active");
    const text = JSON.stringify(await getVerdictFormView(t.db, mine.operator.id, c.id));
    expect(text).not.toContain(mine.operator.id);
    expect(text).not.toMatch(/operator_?id/i);
  });

  it("sends at most two statements", async () => {
    const { mine, c } = await openCase();
    await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "active");
    const spy = vi.spyOn(t.pg, "query");
    await getVerdictFormView(t.db, mine.operator.id, c.id);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("getReputationForAgents", () => {
  it("gives final points, pending points and tier for each agent, in one statement", async () => {
    const a = await f.makeAgent();
    const b = await f.makeAgent();
    const c = await f.makeAgent();
    await plant(a, 30, "final");
    await plant(a, 40, "pending");
    await plant(b, 100, "final");
    await plant(b, 10, "reversed");
    const spy = vi.spyOn(t.pg, "query");
    const map = await getReputationForAgents(t.db, [a.agent.id, b.agent.id, c.agent.id]);
    expect(spy.mock.calls.length).toBe(1);
    expect(map.get(a.agent.id)).toEqual({ points: 30, pending: 40, tier: 1 });
    expect(map.get(b.agent.id)).toEqual({ points: 100, pending: 0, tier: 2 });
    expect(map.get(c.agent.id)).toEqual({ points: 0, pending: 0, tier: 0 });
  });

  it("agrees with getReputation for each agent", async () => {
    const a = await f.makeAgent();
    await plant(a, 300, "final");
    await plant(a, 20, "pending");
    const map = await getReputationForAgents(t.db, [a.agent.id]);
    expect(map.get(a.agent.id)).toEqual(await getReputation(t.db, a.agent.id));
  });

  it("answers an empty map for no ids and skips a malformed id, with no statement when nothing is valid", async () => {
    const spy = vi.spyOn(t.pg, "query");
    expect((await getReputationForAgents(t.db, [])).size).toBe(0);
    expect((await getReputationForAgents(t.db, ["nope"])).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    const a = await f.makeAgent();
    const map = await getReputationForAgents(t.db, ["nope", a.agent.id]);
    expect([...map.keys()]).toEqual([a.agent.id]);
  });
});
