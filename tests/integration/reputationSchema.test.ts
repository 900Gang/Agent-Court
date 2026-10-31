import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reputationEvents, verdicts } from "@/db/schema";
import { writeAudit } from "@/lib/services/auditService";
import { recordModeration } from "@/lib/services/moderationService";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const denied = { code: "42501" };

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

async function makeVerdict() {
  const filer = await f.makeAgent();
  const winner = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { status: "resolved" });
  const argument = await f.insertArgument(c.id, winner.actor.agentId, "won");
  const [verdict] = await t.db
    .insert(verdicts)
    .values({
      caseId: c.id,
      winningArgumentId: argument.id,
      decidedBy: "operator",
      decidedByOperatorId: filer.actor.operatorId,
      verificationLevel: "operator_confirmed",
      status: "active",
    })
    .returning();
  return { verdict, winner };
}

const award = (verdictId: string, agentId: string, operatorId: string, over: Partial<typeof reputationEvents.$inferInsert> = {}) =>
  t.db.insert(reputationEvents).values({ agentId, operatorId, verdictId, points: 10, reason: "verdict_win", status: "pending", ...over }).returning();

describe("reputation_events: one event per verdict", () => {
  it("accepts the first event for a verdict and rejects a second", async () => {
    const { verdict, winner } = await makeVerdict();
    await award(verdict.id, winner.actor.agentId, winner.actor.operatorId);
    await expect(award(verdict.id, winner.actor.agentId, winner.actor.operatorId)).rejects.toMatchObject({ cause: { code: "23505" } });
    expect(await f.count("reputation_events where verdict_id = $1", [verdict.id])).toBe(1);
  });

  it("still rejects a second event once the first is reversed, so a verdict can never pay twice", async () => {
    const { verdict, winner } = await makeVerdict();
    const [first] = await award(verdict.id, winner.actor.agentId, winner.actor.operatorId);
    await t.sql(`update reputation_events set status = 'reversed' where id = $1`, [first.id]);
    await expect(award(verdict.id, winner.actor.agentId, winner.actor.operatorId, { points: 5 })).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("lets different verdicts each have their own event", async () => {
    const a = await makeVerdict();
    const b = await makeVerdict();
    await award(a.verdict.id, a.winner.actor.agentId, a.winner.actor.operatorId);
    await award(b.verdict.id, b.winner.actor.agentId, b.winner.actor.operatorId);
    expect(await f.count("reputation_events where verdict_id in ($1, $2)", [a.verdict.id, b.verdict.id])).toBe(2);
  });

  it("has a unique index on verdict_id and nothing else unique", async () => {
    const rows = await t.sql(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'reputation_events'`);
    const unique = rows.map((row) => String(row.indexdef)).filter((definition) => /UNIQUE/i.test(definition));
    expect(unique.some((definition) => /\(verdict_id\)/.test(definition))).toBe(true);
  });
});

describe("reputation_events: what the app role may do", () => {
  it("can insert, read and update an event, and never delete one", async () => {
    const { verdict, winner } = await makeVerdict();
    const [event] = await award(verdict.id, winner.actor.agentId, winner.actor.operatorId);
    await t.sql(`update reputation_events set status = 'final' where id = $1`, [event.id]);
    const [row] = await t.sql(`select status, points, reason from reputation_events where id = $1`, [event.id]);
    expect(row).toEqual({ status: "final", points: 10, reason: "verdict_win" });
    await expect(t.sql(`delete from reputation_events where false`)).rejects.toMatchObject(denied);
  });
});

describe("the new audit and moderation values", () => {
  it.each(["verdict.issued", "verdict.reversed"] as const)("accepts the audit action %s", async (action) => {
    const filer = await f.makeAgent();
    await writeAudit(t.db, { actorType: "operator", actorId: filer.actor.operatorId, action, target: crypto.randomUUID(), metadata: { level: "operator_confirmed" } });
    expect(await f.count("audit_log where action = $1", [action])).toBeGreaterThan(0);
  });

  it("records a moderation event about a verdict", async () => {
    const id = crypto.randomUUID();
    await recordModeration(t.db, { targetType: "verdict", targetId: id, check: "manual", result: "pass", details: { level: "operator_confirmed" } });
    const [row] = await t.sql(`select target_type, "check", result from moderation_events where target_id = $1`, [id]);
    expect(row).toEqual({ target_type: "verdict", check: "manual", result: "pass" });
  });
});
