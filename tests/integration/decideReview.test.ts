import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operators, type Operator } from "@/db/schema";
import { releaseDue, tierOf } from "@/lib/services/reputationService";
import { getPublicCaseView } from "@/lib/services/observerService";
import { decideReview } from "@/lib/services/reviewService";
import { appealVerdict, getLiveVerdict, issueVerdict } from "@/lib/services/verdictService";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const NOW = new Date("2026-10-31T12:00:00.000Z");
const DAY = 86_400_000;
const DECIDED_AT = new Date(NOW.getTime() + 3 * DAY);
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

type Made = Awaited<ReturnType<ReturnType<typeof createFixtures>["makeAgent"]>>;

async function makeAdmin(status: "active" | "pending" | "suspended" = "active", role: "admin" | "operator" = "admin"): Promise<Operator> {
  const [row] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Admin", role, status }).returning();
  return row;
}

/** A resolved case: `filer` files it, `winner` wins, a fresh agent loses. The verdict is issued at `at`. */
async function resolve(filer: Made, winner: Made, at: Date = NOW) {
  const c = await f.insertCase(filer.actor.agentId, { status: "open", title: "MARK_title" });
  const loser = await f.makeAgent();
  const winning = await f.insertArgument(c.id, winner.actor.agentId, "active");
  const losing = await f.insertArgument(c.id, loser.actor.agentId, "active");
  const issued = f.unwrap(await issueVerdict(t.db, passGate, filer.operator, { caseId: c.id, winningArgumentId: winning.id }, at));
  return { filer, winner, loser, c, winning, losing, verdictId: issued.verdictId };
}

async function freshCase() {
  return resolve(await f.makeAgent(), await f.makeAgent());
}

/** Puts the verdict under review the way an appeal does, or the way an opened report does. */
async function underReview(s: Awaited<ReturnType<typeof freshCase>>, how: "appeal" | "report" = "appeal") {
  if (how === "appeal") {
    f.unwrap(await appealVerdict(t.db, passGate, s.filer.operator, { caseId: s.c.id, reason: "The fix did not hold on the second run." }, new Date(NOW.getTime() + DAY)));
  } else {
    await t.sql(`update verdicts set status = 'under_appeal' where id = $1`, [s.verdictId]);
    await t.sql(`update cases set status = 'under_appeal' where id = $1`, [s.c.id]);
  }
  return s;
}

const decide = (admin: Operator, caseId: string, decision: unknown, at: Date = DECIDED_AT) => decideReview(t.db, admin, { caseId, decision }, at);

async function snapshot(caseId: string) {
  return {
    case: (await t.sql(`select status, resolved_at from cases where id = $1`, [caseId]))[0],
    verdicts: await t.sql(`select id, status, appealed_at, appeal_outcome, appeal_resolved_at from verdicts where case_id = $1 order by created_at, id`, [caseId]),
    arguments: await t.sql(`select id, status from arguments where case_id = $1 order by id`, [caseId]),
    events: await t.sql(`select id, status, points from reputation_events order by id`),
    audit: await f.count("audit_log where action in ('verdict.upheld', 'verdict.overturned')"),
    moderation: await f.count("moderation_events where details ->> 'action' in ('uphold', 'overturn')"),
  };
}

const statusOf = async (table: "cases" | "arguments" | "verdicts" | "reputation_events", id: string) => (await t.sql(`select status from ${table} where id = $1`, [id]))[0].status as string;

describe("decideReview: uphold", () => {
  it("makes the verdict active and the case resolved again, and records the outcome", async () => {
    const admin = await makeAdmin();
    const s = await underReview(await freshCase());
    expect(f.unwrap(await decide(admin, s.c.id, "uphold"))).toEqual({ outcome: "upheld" });
    const [verdict] = await t.sql(`select status, appeal_outcome, appeal_resolved_at, appealed_at from verdicts where id = $1`, [s.verdictId]);
    expect(verdict.status).toBe("active");
    expect(verdict.appeal_outcome).toBe("upheld");
    expect(new Date(verdict.appeal_resolved_at as string).getTime()).toBe(DECIDED_AT.getTime());
    expect(verdict.appealed_at).not.toBeNull();
    expect(await statusOf("cases", s.c.id)).toBe("resolved");
  });

  it("leaves the arguments and the points as they were, and the release job pays them out at the end of the window", async () => {
    const admin = await makeAdmin();
    const s = await underReview(await freshCase());
    f.unwrap(await decide(admin, s.c.id, "uphold"));
    expect(await statusOf("arguments", s.winning.id)).toBe("won");
    expect(await statusOf("arguments", s.losing.id)).toBe("lost");
    const [event] = await t.sql(`select id, status, points from reputation_events where verdict_id = $1`, [s.verdictId]);
    expect(event).toMatchObject({ status: "pending", points: 10 });
    await releaseDue(t.db, new Date(NOW.getTime() + 7 * DAY - 1));
    expect(await statusOf("reputation_events", event.id as string)).toBe("pending");
    await releaseDue(t.db, new Date(NOW.getTime() + 7 * DAY + 1));
    expect(await statusOf("reputation_events", event.id as string)).toBe("final");
  });

  it("works for a review opened from a report, whose appeal columns stay empty except the outcome", async () => {
    const admin = await makeAdmin();
    const s = await underReview(await freshCase(), "report");
    f.unwrap(await decide(admin, s.c.id, "uphold"));
    const [verdict] = await t.sql(`select status, appealed_at, appeal_reason, appeal_outcome from verdicts where id = $1`, [s.verdictId]);
    expect(verdict).toEqual({ status: "active", appealed_at: null, appeal_reason: null, appeal_outcome: "upheld" });
  });

  it("writes one audit row and one moderation event, with ids only", async () => {
    const admin = await makeAdmin();
    const s = await underReview(await freshCase());
    f.unwrap(await decide(admin, s.c.id, "uphold"));
    const audit = await t.sql(`select actor_type, actor_id, target, metadata from audit_log where action = 'verdict.upheld' and target = $1`, [s.verdictId]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: "operator", actor_id: admin.id });
    expect(audit[0].metadata).toMatchObject({ caseId: s.c.id });
    const events = await t.sql(`select "check", result, details from moderation_events where target_type = 'verdict' and target_id = $1 and details ->> 'action' = 'uphold'`, [s.verdictId]);
    expect(events).toEqual([{ check: "manual", result: "pass", details: { action: "uphold" } }]);
  });

  it("does not let the operator appeal again afterwards", async () => {
    const admin = await makeAdmin();
    const s = await underReview(await freshCase());
    f.unwrap(await decide(admin, s.c.id, "uphold"));
    expect(f.errorOf(await appealVerdict(t.db, passGate, s.filer.operator, { caseId: s.c.id, reason: "I would like a second go at this." }, DECIDED_AT))).toBe("already_appealed");
  });
});

describe("decideReview: overturn", () => {
  it("makes the verdict history, the winner overturned, the loser active again, the case argued and the points reversed", async () => {
    const admin = await makeAdmin();
    const s = await underReview(await freshCase());
    expect(f.unwrap(await decide(admin, s.c.id, "overturn"))).toEqual({ outcome: "overturned" });
    const [verdict] = await t.sql(`select status, appeal_outcome, appeal_resolved_at from verdicts where id = $1`, [s.verdictId]);
    expect(verdict.status).toBe("overturned");
    expect(verdict.appeal_outcome).toBe("overturned");
    expect(new Date(verdict.appeal_resolved_at as string).getTime()).toBe(DECIDED_AT.getTime());
    expect(await statusOf("arguments", s.winning.id)).toBe("overturned");
    expect(await statusOf("arguments", s.losing.id)).toBe("active");
    expect(await statusOf("cases", s.c.id)).toBe("argued");
    const [event] = await t.sql(`select status, points from reputation_events where verdict_id = $1`, [s.verdictId]);
    expect(event).toEqual({ status: "reversed", points: 10 });
  });

  it("stops showing the verdict, and shows the case as argued", async () => {
    const admin = await makeAdmin();
    const s = await underReview(await freshCase());
    f.unwrap(await decide(admin, s.c.id, "overturn"));
    expect(await getLiveVerdict(t.db, s.c.id)).toBeNull();
    const view = await getPublicCaseView(t.db, s.c.id);
    expect(view?.verdict).toBeNull();
    expect(view?.case.status).toBe("argued");
  });

  it("works for a review opened from a report", async () => {
    const admin = await makeAdmin();
    const s = await underReview(await freshCase(), "report");
    f.unwrap(await decide(admin, s.c.id, "overturn"));
    expect(await statusOf("cases", s.c.id)).toBe("argued");
    expect(await statusOf("verdicts", s.verdictId)).toBe("overturned");
  });

  it("lets the operator issue a new verdict, which earns points, and keeps the old one as history", async () => {
    const admin = await makeAdmin();
    const s = await underReview(await freshCase());
    f.unwrap(await decide(admin, s.c.id, "overturn"));
    const second = f.unwrap(await issueVerdict(t.db, passGate, s.filer.operator, { caseId: s.c.id, winningArgumentId: s.losing.id }, new Date(NOW.getTime() + 4 * DAY)));
    expect(second).toMatchObject({ level: "operator_confirmed", points: 10 });
    expect(await statusOf("cases", s.c.id)).toBe("resolved");
    const rows = await t.sql(`select id, status from verdicts where case_id = $1`, [s.c.id]);
    expect(rows).toHaveLength(2);
    expect(new Map(rows.map((row) => [row.id as string, row.status as string])).get(s.verdictId)).toBe("overturned");
    expect((await getLiveVerdict(t.db, s.c.id))?.id).toBe(second.verdictId);
  });

  it("does not count the reversed award toward the pairwise cap", async () => {
    const admin = await makeAdmin();
    const filer = await f.makeAgent();
    const winner = await f.makeAgent();
    await resolve(filer, winner, new Date(NOW.getTime() + 1));
    await resolve(filer, winner, new Date(NOW.getTime() + 2));
    const third = await underReview(await resolve(filer, winner, new Date(NOW.getTime() + 3)));
    f.unwrap(await decide(admin, third.c.id, "overturn"));
    const fourth = await resolve(filer, winner, new Date(NOW.getTime() + 4));
    const [event] = await t.sql(`select points, reason from reputation_events where verdict_id = $1`, [fourth.verdictId]);
    expect(event).toEqual({ points: 10, reason: "verdict_win" }); // the fourth award would have paid 5 with the third still counted
  });

  it("takes the tier back on the next request", async () => {
    const admin = await makeAdmin();
    const filer = await f.makeAgent();
    const winner = await f.makeAgent();
    const cases = [await resolve(filer, winner, new Date(NOW.getTime() + 1)), await resolve(filer, winner, new Date(NOW.getTime() + 2)), await resolve(filer, winner, new Date(NOW.getTime() + 3))];
    await t.sql(`update reputation_events set status = 'final' where agent_id = $1`, [winner.actor.agentId]);
    expect(await tierOf(t.db, winner.actor.agentId)).toBe(1);
    await underReview(cases[2], "report");
    f.unwrap(await decide(admin, cases[2].c.id, "overturn"));
    expect(await tierOf(t.db, winner.actor.agentId)).toBe(0);
  });

  it("leaves a withdrawn argument withdrawn, and moves the case to open when nothing active is left", async () => {
    const admin = await makeAdmin();
    const s = await freshCase();
    await t.sql(`update arguments set status = 'withdrawn' where id = $1`, [s.losing.id]);
    await underReview(s, "report");
    f.unwrap(await decide(admin, s.c.id, "overturn"));
    expect(await statusOf("arguments", s.losing.id)).toBe("withdrawn");
    expect(await statusOf("cases", s.c.id)).toBe("open");
  });

  it("does not restore a lost argument whose agent has argued again, and breaks no rule", async () => {
    const admin = await makeAdmin();
    const s = await freshCase();
    const again = await f.insertArgument(s.c.id, s.loser.actor.agentId, "active"); // the agent argued once more after losing
    await underReview(s, "report");
    f.unwrap(await decide(admin, s.c.id, "overturn"));
    expect(await statusOf("arguments", s.losing.id)).toBe("lost");
    expect(await statusOf("arguments", again.id)).toBe("active");
    expect(await statusOf("cases", s.c.id)).toBe("argued");
  });

  it("restores held and other statuses nowhere: only lost arguments change", async () => {
    const admin = await makeAdmin();
    const s = await freshCase();
    const other = await f.makeAgent();
    const held = await f.insertArgument(s.c.id, other.actor.agentId, "held");
    await underReview(s, "report");
    f.unwrap(await decide(admin, s.c.id, "overturn"));
    expect(await statusOf("arguments", held.id)).toBe("held");
  });

  it("writes one audit row with the number restored, and one moderation event", async () => {
    const admin = await makeAdmin();
    const s = await underReview(await freshCase());
    f.unwrap(await decide(admin, s.c.id, "overturn"));
    const audit = await t.sql(`select actor_id, metadata from audit_log where action = 'verdict.overturned' and target = $1`, [s.verdictId]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: admin.id });
    expect(audit[0].metadata).toEqual({ caseId: s.c.id, restored: 1 });
    expect(await f.count(`moderation_events where target_type = 'verdict' and target_id = $1 and details ->> 'action' = 'overturn'`, [s.verdictId])).toBe(1);
  });
});

describe("decideReview: refusals", () => {
  it("refuses anyone who is not an active admin, and writes nothing", async () => {
    const s = await underReview(await freshCase());
    const before = await snapshot(s.c.id);
    const deleted = { ...(await makeAdmin()), deletedAt: new Date("2026-10-20T00:00:00Z") };
    for (const who of [await makeAdmin("active", "operator"), await makeAdmin("pending"), await makeAdmin("suspended"), deleted]) {
      expect(f.errorOf(await decide(who, s.c.id, "overturn"))).toBe("forbidden");
    }
    expect(await snapshot(s.c.id)).toEqual(before);
  });

  it("reads the admin's role and status from the database", async () => {
    const s = await underReview(await freshCase());
    const admin = await makeAdmin();
    await t.sql("reset role");
    await t.sql(`update operators set role = 'operator' where id = $1`, [admin.id]);
    await t.sql("set role app_server");
    expect(f.errorOf(await decide(admin, s.c.id, "overturn"))).toBe("forbidden");
    expect(await statusOf("cases", s.c.id)).toBe("under_appeal");
  });

  it("names the field for a bad case id or an unknown decision", async () => {
    const admin = await makeAdmin();
    const s = await underReview(await freshCase());
    const before = await snapshot(s.c.id);
    const badId = await decide(admin, "nope", "uphold");
    expect(f.errorOf(badId)).toBe("invalid");
    expect(badId.ok === false && Object.keys(badId.detail ?? {})).toEqual(["caseId"]);
    for (const decision of ["", "approve", "dismiss", "OVERTURN", undefined, 7]) {
      const result = await decide(admin, s.c.id, decision);
      expect(f.errorOf(result)).toBe("invalid");
      expect(result.ok === false && Object.keys(result.detail ?? {})).toEqual(["decision"]);
    }
    expect(await snapshot(s.c.id)).toEqual(before);
  });

  it("answers not_found for an unknown case", async () => {
    expect(f.errorOf(await decide(await makeAdmin(), UNKNOWN, "uphold"))).toBe("not_found");
  });

  it.each(["uphold", "overturn"])("refuses to %s a case that is not under review, writing nothing", async (decision) => {
    const admin = await makeAdmin();
    const resolved = await freshCase();
    const open = await f.makeAgent();
    const openCase = await f.insertCase(open.actor.agentId, { status: "open" });
    for (const id of [resolved.c.id, openCase.id]) {
      const before = await snapshot(id);
      expect(f.errorOf(await decide(admin, id, decision))).toBe("illegal_transition");
      expect(await snapshot(id)).toEqual(before);
    }
  });

  it("will not decide the same review twice", async () => {
    const admin = await makeAdmin();
    const upheld = await underReview(await freshCase());
    f.unwrap(await decide(admin, upheld.c.id, "uphold"));
    const before = await snapshot(upheld.c.id);
    expect(f.errorOf(await decide(admin, upheld.c.id, "overturn"))).toBe("illegal_transition");
    expect(f.errorOf(await decide(admin, upheld.c.id, "uphold"))).toBe("illegal_transition");
    expect(await snapshot(upheld.c.id)).toEqual(before);

    const overturned = await underReview(await freshCase());
    f.unwrap(await decide(admin, overturned.c.id, "overturn"));
    expect(f.errorOf(await decide(admin, overturned.c.id, "overturn"))).toBe("illegal_transition");
  });
});

describe("decideReview: two at once", () => {
  it("lets exactly one of two administrators decide", async () => {
    const one = await makeAdmin();
    const two = await makeAdmin();
    const s = await underReview(await freshCase());
    const results = await Promise.all([decide(one, s.c.id, "uphold"), decide(two, s.c.id, "overturn")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(f.errorOf(results.find((result) => !result.ok)!)).toBe("illegal_transition");
    expect(await f.count("audit_log where action in ('verdict.upheld', 'verdict.overturned') and target = $1", [s.verdictId])).toBe(1);
    const status = await statusOf("cases", s.c.id);
    expect(["resolved", "argued"]).toContain(status);
  });

  it("never leaves a final event on an overturned verdict, even with the release job running at the same time", async () => {
    const admin = await makeAdmin();
    const s = await underReview(await freshCase());
    await Promise.all([decide(admin, s.c.id, "overturn"), releaseDue(t.db, new Date(NOW.getTime() + 60 * DAY))]);
    expect(await statusOf("verdicts", s.verdictId)).toBe("overturned");
    const [event] = await t.sql(`select status from reputation_events where verdict_id = $1`, [s.verdictId]);
    expect(event.status).toBe("reversed");
  });
});
