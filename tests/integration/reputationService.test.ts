import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { reputationEvents, verdicts } from "@/db/schema";
import { awardForVerdict, getReputation, releaseDue, reverseForVerdict, tierOf } from "@/lib/services/reputationService";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const NOW = new Date("2026-10-31T12:00:00.000Z");
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

afterEach(() => vi.restoreAllMocks());

type Made = Awaited<ReturnType<typeof f.makeAgent>>;

/** A resolved case filed by `issuer`, argued and won by `winner`, with a verdict issued by `issuer`'s operator. */
async function verdictFor(issuer: Made, winner: Made, status: "active" | "under_appeal" | "overturned" = "active") {
  const c = await f.insertCase(issuer.actor.agentId, { status: "resolved" });
  const argument = await f.insertArgument(c.id, winner.actor.agentId, "won");
  const [verdict] = await t.db
    .insert(verdicts)
    .values({
      caseId: c.id,
      winningArgumentId: argument.id,
      decidedBy: "operator",
      decidedByOperatorId: issuer.actor.operatorId,
      verificationLevel: "operator_confirmed",
      status,
    })
    .returning();
  return verdict;
}

const award = (issuer: Made, winner: Made, verdictId: string, at = NOW) =>
  awardForVerdict(t.db, {
    verdictId,
    agentId: winner.actor.agentId,
    receivingOperatorId: winner.actor.operatorId,
    issuingOperatorId: issuer.actor.operatorId,
    at,
  });

const eventOf = async (verdictId: string) => (await t.sql(`select points, status, reason, release_at from reputation_events where verdict_id = $1`, [verdictId]))[0];

/** An event for `agent`, inserted directly with the given points and status, on a verdict of its own. */
async function plantEvent(agent: Made, points: number, status: "pending" | "final" | "reversed", releaseAt: Date | null = null, verdictStatus: "active" | "under_appeal" | "overturned" = "active") {
  const issuer = await f.makeAgent();
  const verdict = await verdictFor(issuer, agent, verdictStatus);
  const [event] = await t.db
    .insert(reputationEvents)
    .values({ agentId: agent.actor.agentId, operatorId: agent.actor.operatorId, verdictId: verdict.id, points, reason: "verdict_win", status, releaseAt })
    .returning();
  return { event, verdict };
}

describe("awardForVerdict: the pairwise cap", () => {
  it("pays 10, 10, 10, 5, 2 and then 0 for the same issuing and receiving operators, and keeps a row for the zero", async () => {
    const issuer = await f.makeAgent();
    const winner = await f.makeAgent();
    const paid: number[] = [];
    const reasons: string[] = [];
    for (let i = 0; i < 7; i++) {
      const verdict = await verdictFor(issuer, winner);
      paid.push((await award(issuer, winner, verdict.id)).points);
      reasons.push(String((await eventOf(verdict.id)).reason));
    }
    expect(paid).toEqual([10, 10, 10, 5, 2, 0, 0]);
    expect(reasons).toEqual(["verdict_win", "verdict_win", "verdict_win", "verdict_win_capped_5", "verdict_win_capped_2", "verdict_win_capped_0", "verdict_win_capped_0"]);
    expect(await f.count("reputation_events where operator_id = $1", [winner.actor.operatorId])).toBe(7);
  });

  it("records each award as pending, for the winner's agent and operator, released seven days after the verdict", async () => {
    const issuer = await f.makeAgent();
    const winner = await f.makeAgent();
    const verdict = await verdictFor(issuer, winner);
    await award(issuer, winner, verdict.id);
    const [row] = await t.sql(`select agent_id, operator_id, points, status, release_at from reputation_events where verdict_id = $1`, [verdict.id]);
    expect(row.agent_id).toBe(winner.actor.agentId);
    expect(row.operator_id).toBe(winner.actor.operatorId);
    expect(row.points).toBe(10);
    expect(row.status).toBe("pending");
    expect(new Date(String(row.release_at)).getTime()).toBe(NOW.getTime() + 7 * DAY);
  });

  it("counts each pair on its own: another issuer or another receiver starts again at 10", async () => {
    const issuer = await f.makeAgent();
    const otherIssuer = await f.makeAgent();
    const winner = await f.makeAgent();
    const otherWinner = await f.makeAgent();
    for (let i = 0; i < 4; i++) await award(issuer, winner, (await verdictFor(issuer, winner)).id);
    expect((await award(otherIssuer, winner, (await verdictFor(otherIssuer, winner)).id)).points).toBe(10);
    expect((await award(issuer, otherWinner, (await verdictFor(issuer, otherWinner)).id)).points).toBe(10);
    expect((await award(issuer, winner, (await verdictFor(issuer, winner)).id)).points).toBe(2);
  });

  it("shares the count across the receiving operator's agents, so a second agent does not reset the cap", async () => {
    const issuer = await f.makeAgent();
    const first = await f.makeAgent();
    const second = await f.makeAgent(first.operator);
    for (let i = 0; i < 3; i++) await award(issuer, first, (await verdictFor(issuer, first)).id);
    expect((await award(issuer, second, (await verdictFor(issuer, second)).id)).points).toBe(5);
  });

  it("shares the count across the issuing operator's agents", async () => {
    const issuerOne = await f.makeAgent();
    const issuerTwo = await f.makeAgent(issuerOne.operator);
    const winner = await f.makeAgent();
    for (let i = 0; i < 3; i++) await award(issuerOne, winner, (await verdictFor(issuerOne, winner)).id);
    expect((await award(issuerTwo, winner, (await verdictFor(issuerTwo, winner)).id)).points).toBe(5);
  });

  it("does not count a reversed award, so reversing one frees a step", async () => {
    const issuer = await f.makeAgent();
    const winner = await f.makeAgent();
    const first = await verdictFor(issuer, winner);
    await award(issuer, winner, first.id);
    for (let i = 0; i < 2; i++) await award(issuer, winner, (await verdictFor(issuer, winner)).id);
    await reverseForVerdict(t.db, first.id);
    expect((await award(issuer, winner, (await verdictFor(issuer, winner)).id)).points).toBe(10);
  });

  it("locks the issuing operator's row first, so two awards at once cannot read the same count", async () => {
    const issuer = await f.makeAgent();
    const winner = await f.makeAgent();
    const verdict = await verdictFor(issuer, winner);
    const spy = vi.spyOn(t.pg, "query");
    await award(issuer, winner, verdict.id);
    const statements = spy.mock.calls.map((call) => String(call[0]).toLowerCase());
    expect(statements.some((sql) => sql.includes("for update") && sql.includes("operators"))).toBe(true);
  });
});

describe("releaseDue: pending becomes final when the window ends", () => {
  it("releases a pending event at its release time, and not a moment before", async () => {
    const agent = await f.makeAgent();
    const { event } = await plantEvent(agent, 10, "pending", new Date(NOW.getTime() + 1));
    await releaseDue(t.db, NOW);
    expect((await t.sql(`select status from reputation_events where id = $1`, [event.id]))[0].status).toBe("pending");
    await releaseDue(t.db, new Date(NOW.getTime() + 1));
    expect((await t.sql(`select status from reputation_events where id = $1`, [event.id]))[0].status).toBe("final");
  });

  it("releases only the due events in a mixed batch, and reports how many", async () => {
    const agent = await f.makeAgent();
    const due = [await plantEvent(agent, 10, "pending", new Date(NOW.getTime() - DAY)), await plantEvent(agent, 10, "pending", new Date(NOW.getTime() - 1))];
    const later = await plantEvent(agent, 10, "pending", new Date(NOW.getTime() + DAY));
    const alreadyFinal = await plantEvent(agent, 10, "final", new Date(NOW.getTime() - DAY));
    const reversed = await plantEvent(agent, 10, "reversed", new Date(NOW.getTime() - DAY));
    const released = await releaseDue(t.db, NOW);
    expect(released).toBeGreaterThanOrEqual(2);
    for (const { event } of due) expect((await t.sql(`select status from reputation_events where id = $1`, [event.id]))[0].status).toBe("final");
    expect((await t.sql(`select status from reputation_events where id = $1`, [later.event.id]))[0].status).toBe("pending");
    expect((await t.sql(`select status from reputation_events where id = $1`, [alreadyFinal.event.id]))[0].status).toBe("final");
    expect((await t.sql(`select status from reputation_events where id = $1`, [reversed.event.id]))[0].status).toBe("reversed");
  });

  it.each(["under_appeal", "overturned"] as const)("never releases an event whose verdict is %s", async (verdictStatus) => {
    const agent = await f.makeAgent();
    const { event } = await plantEvent(agent, 10, "pending", new Date(NOW.getTime() - DAY), verdictStatus);
    await releaseDue(t.db, NOW);
    expect((await t.sql(`select status from reputation_events where id = $1`, [event.id]))[0].status).toBe("pending");
  });

  it("is idempotent: a second run releases nothing more", async () => {
    const agent = await f.makeAgent();
    await plantEvent(agent, 10, "pending", new Date(NOW.getTime() - DAY));
    await releaseDue(t.db, NOW);
    expect(await releaseDue(t.db, NOW)).toBe(0);
  });

  it("never releases an event that has no release time", async () => {
    const agent = await f.makeAgent();
    const { event } = await plantEvent(agent, 10, "pending", null);
    await releaseDue(t.db, new Date(NOW.getTime() + 365 * DAY));
    expect((await t.sql(`select status from reputation_events where id = $1`, [event.id]))[0].status).toBe("pending");
  });
});

describe("reverseForVerdict", () => {
  it.each(["pending", "final"] as const)("turns a %s event into a reversed one", async (status) => {
    const agent = await f.makeAgent();
    const { event, verdict } = await plantEvent(agent, 10, status, NOW);
    expect(await reverseForVerdict(t.db, verdict.id)).toBe(true);
    expect((await t.sql(`select status, points from reputation_events where id = $1`, [event.id]))[0]).toEqual({ status: "reversed", points: 10 });
  });

  it("is idempotent, and false for a verdict that has no event", async () => {
    const agent = await f.makeAgent();
    const { verdict } = await plantEvent(agent, 10, "pending", NOW);
    expect(await reverseForVerdict(t.db, verdict.id)).toBe(true);
    expect(await reverseForVerdict(t.db, verdict.id)).toBe(false);
    expect(await reverseForVerdict(t.db, crypto.randomUUID())).toBe(false);
    const issuer = await f.makeAgent();
    expect(await reverseForVerdict(t.db, (await verdictFor(issuer, agent)).id)).toBe(false);
  });

  it("touches only that verdict's event", async () => {
    const agent = await f.makeAgent();
    const one = await plantEvent(agent, 10, "final", NOW);
    const two = await plantEvent(agent, 10, "final", NOW);
    await reverseForVerdict(t.db, one.verdict.id);
    expect((await t.sql(`select status from reputation_events where id = $1`, [two.event.id]))[0].status).toBe("final");
  });
});

describe("getReputation and tierOf", () => {
  it.each([
    [0, 0],
    [29, 0],
    [30, 1],
    [99, 1],
    [100, 2],
    [299, 2],
    [300, 3],
  ])("gives an agent with %i final points tier %i", async (points, tier) => {
    const agent = await f.makeAgent();
    if (points > 0) await plantEvent(agent, points, "final", NOW);
    expect(await getReputation(t.db, agent.actor.agentId)).toEqual({ points, pending: 0, tier });
    expect(await tierOf(t.db, agent.actor.agentId)).toBe(tier);
  });

  it("adds up several final events, and reports pending points without counting them", async () => {
    const agent = await f.makeAgent();
    await plantEvent(agent, 10, "final", NOW);
    await plantEvent(agent, 20, "final", NOW);
    await plantEvent(agent, 500, "pending", new Date(NOW.getTime() + DAY));
    expect(await getReputation(t.db, agent.actor.agentId)).toEqual({ points: 30, pending: 500, tier: 1 });
    expect(await tierOf(t.db, agent.actor.agentId)).toBe(1);
  });

  it("never lets pending points raise a tier", async () => {
    const agent = await f.makeAgent();
    await plantEvent(agent, 1000, "pending", new Date(NOW.getTime() + DAY));
    expect(await tierOf(t.db, agent.actor.agentId)).toBe(0);
  });

  it("does not count reversed events, and a reversal lowers the tier at once", async () => {
    const agent = await f.makeAgent();
    const { verdict } = await plantEvent(agent, 30, "final", NOW);
    await plantEvent(agent, 100, "reversed", NOW);
    expect(await tierOf(t.db, agent.actor.agentId)).toBe(1);
    await reverseForVerdict(t.db, verdict.id);
    expect(await tierOf(t.db, agent.actor.agentId)).toBe(0);
    expect(await getReputation(t.db, agent.actor.agentId)).toEqual({ points: 0, pending: 0, tier: 0 });
  });

  it("keeps agents apart, even agents of one operator", async () => {
    const first = await f.makeAgent();
    const second = await f.makeAgent(first.operator);
    await plantEvent(first, 100, "final", NOW);
    expect(await tierOf(t.db, first.actor.agentId)).toBe(2);
    expect(await tierOf(t.db, second.actor.agentId)).toBe(0);
  });

  it("gives an unknown or malformed agent tier 0 and no error", async () => {
    expect(await tierOf(t.db, crypto.randomUUID())).toBe(0);
    expect(await tierOf(t.db, "not-a-uuid")).toBe(0);
    expect(await getReputation(t.db, "not-a-uuid")).toEqual({ points: 0, pending: 0, tier: 0 });
  });

  it("asks the database one question for a tier", async () => {
    const agent = await f.makeAgent();
    await plantEvent(agent, 30, "final", NOW);
    const spy = vi.spyOn(t.pg, "query");
    await tierOf(t.db, agent.actor.agentId);
    expect(spy.mock.calls.length).toBe(1);
  });
});
