import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operators, type Operator } from "@/db/schema";
import { createGate } from "@/lib/safety/engine";
import type { SafetyGate } from "@/lib/safety/gate";
import { releaseDue } from "@/lib/services/reputationService";
import { appealVerdict, getLiveVerdict, issueVerdict } from "@/lib/services/verdictService";
import { blockGate, flagGate, passGate, throwingGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const NOW = new Date("2026-10-31T12:00:00.000Z");
const DAY = 86_400_000;
const LATER = new Date(NOW.getTime() + 2 * DAY);
const REASON = "The fix did not hold: the loop returned on the second run.";
const REFUSED = "was not accepted: remove secrets, personal data and instructions";
const aws = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const UNKNOWN = "00000000-0000-4000-8000-00000000dead";

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

/** A resolved case with a confirmed verdict issued at NOW, a winner and a loser. */
async function resolvedCase() {
  const filer = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { status: "open" });
  const winner = await f.makeAgent();
  const loser = await f.makeAgent();
  const winning = await f.insertArgument(c.id, winner.actor.agentId, "active");
  const losing = await f.insertArgument(c.id, loser.actor.agentId, "active");
  const issued = f.unwrap(await issueVerdict(t.db, passGate, filer.operator, { caseId: c.id, winningArgumentId: winning.id }, NOW));
  return { filer, c, winner, loser, winning, losing, verdictId: issued.verdictId };
}

const appeal = (operator: Operator, caseId: string, reason: unknown = REASON, gate: SafetyGate = passGate, at: Date = LATER) =>
  appealVerdict(t.db, gate, operator, { caseId, reason }, at);

async function snapshot(caseId: string) {
  return {
    verdict: await t.sql(`select status, appealed_at, appeal_reason, appeal_outcome, appeal_resolved_at from verdicts where case_id = $1 order by created_at, id`, [caseId]),
    status: (await t.sql(`select status from cases where id = $1`, [caseId]))[0].status as string,
    arguments: await t.sql(`select id, status from arguments where case_id = $1 order by id`, [caseId]),
    audit: await f.count("audit_log where action = 'appeal.filed'"),
    moderation: await f.count("moderation_events where target_type = 'verdict'"),
    events: await t.sql(`select id, status, points from reputation_events order by id`),
  };
}

describe("appealVerdict: a successful appeal", () => {
  it("puts the verdict and the case under appeal and records the reason and the time", async () => {
    const s = await resolvedCase();
    const result = f.unwrap(await appeal(s.filer.operator, s.c.id));
    expect(result).toEqual({ verdictId: s.verdictId, caseId: s.c.id });

    const [verdict] = await t.sql(`select status, appealed_at, appeal_reason, appeal_outcome, appeal_resolved_at from verdicts where id = $1`, [s.verdictId]);
    expect(verdict.status).toBe("under_appeal");
    expect(new Date(verdict.appealed_at as string).getTime()).toBe(LATER.getTime());
    expect(verdict.appeal_reason).toBe(REASON);
    expect(verdict.appeal_outcome).toBeNull();
    expect(verdict.appeal_resolved_at).toBeNull();
    expect((await t.sql(`select status from cases where id = $1`, [s.c.id]))[0].status).toBe("under_appeal");
    expect((await getLiveVerdict(t.db, s.c.id))?.status).toBe("under_appeal");
  });

  it("leaves the arguments as they were", async () => {
    const s = await resolvedCase();
    f.unwrap(await appeal(s.filer.operator, s.c.id));
    const rows = await t.sql(`select id, status from arguments where case_id = $1`, [s.c.id]);
    const byId = new Map(rows.map((row) => [row.id as string, row.status as string]));
    expect(byId.get(s.winning.id)).toBe("won");
    expect(byId.get(s.losing.id)).toBe("lost");
  });

  it("keeps the winner's points pending, and the release job leaves them alone", async () => {
    const s = await resolvedCase();
    f.unwrap(await appeal(s.filer.operator, s.c.id));
    await releaseDue(t.db, new Date(NOW.getTime() + 60 * DAY));
    const [event] = await t.sql(`select status, points from reputation_events where verdict_id = $1`, [s.verdictId]);
    expect(event).toEqual({ status: "pending", points: 10 });
  });

  it("writes one audit row and one moderation event, with ids and no reason", async () => {
    const s = await resolvedCase();
    const marker = "PLANTED_REASON_MARKER_42 the loop came back";
    f.unwrap(await appeal(s.filer.operator, s.c.id, marker));
    const audit = await t.sql(`select actor_type, actor_id, action, target, metadata from audit_log where action = 'appeal.filed' and target = $1`, [s.verdictId]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: "operator", actor_id: s.filer.operator.id, target: s.verdictId });
    expect(JSON.stringify(audit[0].metadata)).toContain(s.c.id);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("PLANTED_REASON_MARKER_42");

    const moderation = await t.sql(`select "check", result, details from moderation_events where target_type = 'verdict' and target_id = $1 order by created_at`, [s.verdictId]);
    expect(moderation).toHaveLength(2); // the verdict and the appeal
    expect(moderation[1]).toMatchObject({ check: "manual", result: "pass", details: { action: "appeal" } });
    expect(JSON.stringify(moderation)).not.toContain("PLANTED_REASON_MARKER_42");
  });

  it("stores the reason the gate returns, with a secret redacted", async () => {
    const s = await resolvedCase();
    f.unwrap(await appeal(s.filer.operator, s.c.id, `The winner printed ${aws} in its log.`, createGate()));
    const [verdict] = await t.sql(`select appeal_reason from verdicts where id = $1`, [s.verdictId]);
    expect(verdict.appeal_reason).toContain("[REDACTED:aws_access_key]");
    expect(verdict.appeal_reason).not.toContain(aws);
  });
});

describe("appealVerdict: the deadline", () => {
  it("accepts an appeal at exactly seven days and refuses one a millisecond later", async () => {
    const onTime = await resolvedCase();
    f.unwrap(await appeal(onTime.filer.operator, onTime.c.id, REASON, passGate, new Date(NOW.getTime() + 7 * DAY)));

    const late = await resolvedCase();
    const before = await snapshot(late.c.id);
    expect(f.errorOf(await appeal(late.filer.operator, late.c.id, REASON, passGate, new Date(NOW.getTime() + 7 * DAY + 1)))).toBe("appeal_window_closed");
    expect(await snapshot(late.c.id)).toEqual(before);
  });
});

describe("appealVerdict: who may appeal", () => {
  it("answers not_found for an unknown case and for another operator's case, the same", async () => {
    const s = await resolvedCase();
    const stranger = await f.makeOperator();
    const before = await snapshot(s.c.id);
    expect(f.errorOf(await appeal(stranger, s.c.id))).toBe("not_found");
    expect(f.errorOf(await appeal(stranger, UNKNOWN))).toBe("not_found");
    expect(await snapshot(s.c.id)).toEqual(before);
  });

  it("does not let the winner's operator, or the loser's operator, appeal", async () => {
    const s = await resolvedCase();
    const before = await snapshot(s.c.id);
    expect(f.errorOf(await appeal(s.winner.operator, s.c.id))).toBe("not_found");
    expect(f.errorOf(await appeal(s.loser.operator, s.c.id))).toBe("not_found");
    expect(await snapshot(s.c.id)).toEqual(before);
  });

  it.each(["pending", "suspended"] as const)("refuses a %s operator", async (status) => {
    const s = await resolvedCase();
    const [operator] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Op", status }).returning();
    const before = await snapshot(s.c.id);
    expect(f.errorOf(await appeal(operator, s.c.id))).toBe("operator_not_active");
    expect(await snapshot(s.c.id)).toEqual(before);
  });

  it("reads the operator's status from the database, not from the object it is given", async () => {
    const s = await resolvedCase();
    await t.sql("reset role");
    await t.sql(`update operators set status = 'suspended' where id = $1`, [s.filer.operator.id]);
    await t.sql("set role app_server");
    expect(f.errorOf(await appeal(s.filer.operator, s.c.id))).toBe("operator_not_active");
    expect((await t.sql(`select status from verdicts where id = $1`, [s.verdictId]))[0].status).toBe("active");
  });

  it("checks the operator before the input", async () => {
    const [operator] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Op", status: "pending" }).returning();
    expect(f.errorOf(await appealVerdict(t.db, passGate, operator, {}, LATER))).toBe("operator_not_active");
  });
});

describe("appealVerdict: what can be appealed", () => {
  it("refuses a case with no verdict", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    expect(f.errorOf(await appeal(filer.operator, c.id))).toBe("illegal_transition");
    expect((await t.sql(`select status from cases where id = $1`, [c.id]))[0].status).toBe("open");
  });

  it("refuses a second appeal, the same operator and the same verdict, and writes nothing the second time", async () => {
    const s = await resolvedCase();
    f.unwrap(await appeal(s.filer.operator, s.c.id));
    const before = await snapshot(s.c.id);
    expect(f.errorOf(await appeal(s.filer.operator, s.c.id, "A different and longer reason this time."))).toBe("already_appealed");
    expect(await snapshot(s.c.id)).toEqual(before);
  });

  it("still says already_appealed after an administrator upheld the verdict", async () => {
    const s = await resolvedCase();
    f.unwrap(await appeal(s.filer.operator, s.c.id));
    await t.sql(`update verdicts set status = 'active', appeal_outcome = 'upheld', appeal_resolved_at = $2 where id = $1`, [s.verdictId, LATER.toISOString()]);
    await t.sql(`update cases set status = 'resolved' where id = $1`, [s.c.id]);
    const before = await snapshot(s.c.id);
    expect(f.errorOf(await appeal(s.filer.operator, s.c.id))).toBe("already_appealed");
    expect(await snapshot(s.c.id)).toEqual(before);
  });

  it("refuses a verdict an administrator already put under review from a report", async () => {
    const s = await resolvedCase();
    await t.sql(`update verdicts set status = 'under_appeal' where id = $1`, [s.verdictId]);
    await t.sql(`update cases set status = 'under_appeal' where id = $1`, [s.c.id]);
    const before = await snapshot(s.c.id);
    expect(f.errorOf(await appeal(s.filer.operator, s.c.id))).toBe("illegal_transition");
    expect(await snapshot(s.c.id)).toEqual(before);
  });

  it("refuses a case whose only verdict was overturned", async () => {
    const s = await resolvedCase();
    await t.sql(`update verdicts set status = 'overturned' where id = $1`, [s.verdictId]);
    await t.sql(`update cases set status = 'argued' where id = $1`, [s.c.id]);
    expect(f.errorOf(await appeal(s.filer.operator, s.c.id))).toBe("illegal_transition");
  });

  it("lets the operator appeal a new verdict after an overturn, and leaves the old one as history", async () => {
    const s = await resolvedCase();
    await t.sql(`update verdicts set status = 'overturned' where id = $1`, [s.verdictId]);
    await t.sql(`update arguments set status = 'overturned' where id = $1`, [s.winning.id]);
    await t.sql(`update arguments set status = 'active' where id = $1`, [s.losing.id]);
    await t.sql(`update cases set status = 'argued', resolved_at = null where id = $1`, [s.c.id]);
    const second = f.unwrap(await issueVerdict(t.db, passGate, s.filer.operator, { caseId: s.c.id, winningArgumentId: s.losing.id }, new Date(NOW.getTime() + DAY)));
    f.unwrap(await appeal(s.filer.operator, s.c.id, REASON, passGate, new Date(NOW.getTime() + 2 * DAY)));
    const rows = await t.sql(`select id, status, appealed_at from verdicts where case_id = $1`, [s.c.id]);
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    expect(byId.get(s.verdictId)).toMatchObject({ status: "overturned", appealed_at: null });
    expect(byId.get(second.verdictId)?.status).toBe("under_appeal");
  });
});

describe("appealVerdict: the reason", () => {
  it("refuses a reason that is too short or too long and names the field", async () => {
    const s = await resolvedCase();
    const before = await snapshot(s.c.id);
    // Sent straight to the service: the `appeal` helper would replace an undefined reason with a valid default.
    for (const reason of ["short", "r".repeat(501), "", undefined, 12345]) {
      const result = await appealVerdict(t.db, passGate, s.filer.operator, { caseId: s.c.id, reason }, LATER);
      expect(f.errorOf(result)).toBe("invalid");
      expect(result.ok === false && Object.keys(result.detail ?? {})).toEqual(["reason"]);
    }
    expect(await snapshot(s.c.id)).toEqual(before);
  });

  it.each([
    ["blocks", blockGate],
    ["flags", flagGate],
    ["fails", throwingGate],
  ])("refuses a reason the gate %s, with a fixed message and nothing written", async (_name, gate) => {
    const s = await resolvedCase();
    const before = await snapshot(s.c.id);
    const result = await appeal(s.filer.operator, s.c.id, REASON, gate);
    expect(f.errorOf(result)).toBe("invalid");
    expect(result.ok === false && result.detail).toEqual({ reason: REFUSED });
    expect(await snapshot(s.c.id)).toEqual(before);
  });

  it("never puts the reason into the answer of a refusal", async () => {
    const s = await resolvedCase();
    const marker = "PLANTED_MARKER_777 and some more words";
    const result = await appeal(s.filer.operator, s.c.id, marker, blockGate);
    expect(JSON.stringify(result)).not.toContain("PLANTED_MARKER_777");
  });
});

describe("appealVerdict: two at once", () => {
  it("lets exactly one of two simultaneous appeals through", async () => {
    const s = await resolvedCase();
    const results = await Promise.all([appeal(s.filer.operator, s.c.id, "First reason, long enough to pass."), appeal(s.filer.operator, s.c.id, "Second reason, long enough too.")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(f.errorOf(results.find((result) => !result.ok)!)).toBe("already_appealed");
    expect(await f.count("audit_log where action = 'appeal.filed' and target = $1", [s.verdictId])).toBe(1);
  });
});
