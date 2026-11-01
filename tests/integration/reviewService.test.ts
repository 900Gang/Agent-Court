import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { operators, reports, type Operator } from "@/db/schema";
import { handleReport, listAppeals, listReports } from "@/lib/services/reviewService";
import { releaseDue } from "@/lib/services/reputationService";
import { appealVerdict, issueVerdict } from "@/lib/services/verdictService";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const NOW = new Date("2026-10-31T12:00:00.000Z");
const DAY = 86_400_000;
const REASON = "This fix tells the next reader to ignore their own rules and copy a key.";
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

async function makeAdmin(status: "active" | "pending" | "suspended" = "active", role: "admin" | "operator" = "admin"): Promise<Operator> {
  const [row] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Admin", role, status }).returning();
  return row;
}

/** A resolved case with a confirmed verdict issued at NOW. */
async function resolvedCase() {
  const filer = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { status: "open", title: "MARK_title" });
  const winner = await f.makeAgent();
  const loser = await f.makeAgent();
  const winning = await f.insertArgument(c.id, winner.actor.agentId, "active");
  const losing = await f.insertArgument(c.id, loser.actor.agentId, "active");
  const issued = f.unwrap(await issueVerdict(t.db, passGate, filer.operator, { caseId: c.id, winningArgumentId: winning.id }, NOW));
  return { filer, c, winner, loser, winning, losing, verdictId: issued.verdictId };
}

async function report(targetType: "case" | "argument", targetId: string, over: { reason?: string; createdAt?: Date; status?: "open" | "reviewed" | "dismissed" | "actioned" } = {}) {
  const reporter = await f.makeOperator();
  const [row] = await t.db
    .insert(reports)
    .values({ reporterOperatorId: reporter.id, targetType, targetId, reason: over.reason ?? REASON, status: over.status ?? "open", ...(over.createdAt ? { createdAt: over.createdAt } : {}) })
    .returning();
  return { ...row, reporter };
}

async function snapshot(caseId: string, reportId?: string) {
  return {
    case: (await t.sql(`select status from cases where id = $1`, [caseId]))[0].status as string,
    verdicts: await t.sql(`select status, appealed_at, appeal_reason, appeal_outcome from verdicts where case_id = $1 order by created_at, id`, [caseId]),
    arguments: await t.sql(`select id, status from arguments where case_id = $1 order by id`, [caseId]),
    report: reportId ? (await t.sql(`select status from reports where id = $1`, [reportId]))[0].status : null,
    audit: await f.count("audit_log where action in ('report.handled', 'review.opened')"),
    moderation: await f.count("moderation_events where details ->> 'action' in ('dismiss', 'reviewed', 'open_review')"),
    events: await t.sql(`select id, status, points from reputation_events order by id`),
  };
}

describe("listReports", () => {
  it("lists only open reports, oldest first, with the case the target belongs to", async () => {
    const s = await resolvedCase();
    const older = await report("case", s.c.id, { createdAt: new Date(NOW.getTime() - 3 * DAY) });
    const newer = await report("argument", s.winning.id, { createdAt: new Date(NOW.getTime() - DAY) });
    await report("case", s.c.id, { status: "dismissed" });
    await report("case", s.c.id, { status: "reviewed" });
    await report("case", s.c.id, { status: "actioned" });
    const { reports: items } = await listReports(t.db);
    const mine = items.filter((item) => item.caseId === s.c.id);
    expect(mine.map((item) => item.id)).toEqual([older.id, newer.id]);
    expect(mine[0]).toMatchObject({ targetType: "case", targetId: s.c.id, caseTitle: "MARK_title", caseStatus: "resolved", reason: REASON, createdAt: older.createdAt });
    expect(mine[1]).toMatchObject({ targetType: "argument", targetId: s.winning.id, caseId: s.c.id, caseTitle: "MARK_title" });
  });

  it("says a review can be opened only for a resolved case with an active verdict, from a case report or an argument report", async () => {
    const good = await resolvedCase();
    const goodCase = await report("case", good.c.id);
    const goodArgument = await report("argument", good.losing.id);

    const open = await f.makeAgent();
    const openCase = await f.insertCase(open.actor.agentId, { status: "open" });
    const openReport = await report("case", openCase.id);

    const appealed = await resolvedCase();
    f.unwrap(await appealVerdict(t.db, passGate, appealed.filer.operator, { caseId: appealed.c.id, reason: "The fix did not hold on the second run." }, new Date(NOW.getTime() + DAY)));
    const appealedReport = await report("case", appealed.c.id);

    const overturned = await resolvedCase();
    await t.sql(`update verdicts set status = 'overturned' where id = $1`, [overturned.verdictId]);
    await t.sql(`update cases set status = 'argued' where id = $1`, [overturned.c.id]);
    const overturnedReport = await report("case", overturned.c.id);

    const { reports: items } = await listReports(t.db, { limit: 500 });
    const can = (id: string) => items.find((item) => item.id === id)?.canOpenReview;
    expect(can(goodCase.id)).toBe(true);
    expect(can(goodArgument.id)).toBe(true);
    expect(can(openReport.id)).toBe(false);
    expect(can(appealedReport.id)).toBe(false);
    expect(can(overturnedReport.id)).toBe(false);
  });

  it("caps the list at the limit and says when it was cut", async () => {
    const s = await resolvedCase();
    const reporter = await f.makeOperator();
    await t.db.insert(reports).values(
      Array.from({ length: 55 }, (_, i) => ({
        reporterOperatorId: reporter.id,
        targetType: "case" as const,
        targetId: s.c.id,
        reason: REASON,
        createdAt: new Date(Date.UTC(2020, 0, 1) + i * 60_000),
      })),
    );
    const page = await listReports(t.db, { limit: 50 });
    expect(page.reports).toHaveLength(50);
    expect(page.truncated).toBe(true);
    const small = await listReports(t.db, { limit: 2 });
    expect(small.reports).toHaveLength(2);
    expect(small.truncated).toBe(true);
  });

  it("holds no reporter and no operator id", async () => {
    const s = await resolvedCase();
    const r = await report("case", s.c.id);
    const text = JSON.stringify((await listReports(t.db, { limit: 500 })).reports.filter((item) => item.id === r.id));
    expect(text).not.toContain(r.reporter.id);
    expect(text).not.toContain(s.filer.operator.id);
    expect(text).not.toMatch(/operator_?id|reporter/i);
  });

  it("does not fail on a report whose target is gone, and cannot open a review for it", async () => {
    const orphan = await report("case", UNKNOWN);
    const item = (await listReports(t.db, { limit: 500 })).reports.find((row) => row.id === orphan.id);
    expect(item).toMatchObject({ caseId: null, caseTitle: null, caseStatus: null, canOpenReview: false });
  });

  it("sends a small fixed number of statements", async () => {
    const s = await resolvedCase();
    await report("case", s.c.id);
    await report("argument", s.winning.id);
    const spy = vi.spyOn(t.pg, "query");
    await listReports(t.db);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4);
    spy.mockRestore();
  });
});

describe("listAppeals", () => {
  it("lists only verdicts under appeal, oldest first, saying how each came to be there", async () => {
    const appealed = await resolvedCase();
    f.unwrap(await appealVerdict(t.db, passGate, appealed.filer.operator, { caseId: appealed.c.id, reason: "The fix did not hold on the second run." }, new Date(NOW.getTime() + DAY)));

    const reviewed = await resolvedCase();
    await t.sql(`update verdicts set status = 'under_appeal' where id = $1`, [reviewed.verdictId]);
    await t.sql(`update cases set status = 'under_appeal' where id = $1`, [reviewed.c.id]);

    const quiet = await resolvedCase(); // still active: not listed
    const { appeals } = await listAppeals(t.db, { limit: 500 });
    const byCase = new Map(appeals.map((item) => [item.caseId, item]));
    expect(byCase.has(quiet.c.id)).toBe(false);
    expect(byCase.get(appealed.c.id)).toMatchObject({
      verdictId: appealed.verdictId,
      caseTitle: "MARK_title",
      origin: "appeal",
      appealReason: "The fix did not hold on the second run.",
      pendingPoints: 10,
      verdictAt: NOW,
    });
    expect(byCase.get(reviewed.c.id)).toMatchObject({ origin: "review", appealReason: null, pendingPoints: 10 });
  });

  it("shows no pending points for a verdict that earned none", async () => {
    const filer = await f.makeAgent();
    const own = await f.makeAgent(filer.operator);
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const argument = await f.insertArgument(c.id, own.actor.agentId, "active");
    f.unwrap(await issueVerdict(t.db, passGate, filer.operator, { caseId: c.id, winningArgumentId: argument.id }, NOW));
    await t.sql(`update verdicts set status = 'under_appeal' where case_id = $1`, [c.id]);
    const item = (await listAppeals(t.db, { limit: 500 })).appeals.find((row) => row.caseId === c.id);
    expect(item?.pendingPoints).toBe(0);
  });

  it("caps the list and says when it was cut, and holds no operator id", async () => {
    const a = await resolvedCase();
    const b = await resolvedCase();
    for (const s of [a, b]) {
      await t.sql(`update verdicts set status = 'under_appeal' where id = $1`, [s.verdictId]);
      await t.sql(`update cases set status = 'under_appeal' where id = $1`, [s.c.id]);
    }
    const page = await listAppeals(t.db, { limit: 1 });
    expect(page.appeals).toHaveLength(1);
    expect(page.truncated).toBe(true);
    const text = JSON.stringify((await listAppeals(t.db, { limit: 500 })).appeals);
    expect(text).not.toContain(a.filer.operator.id);
    expect(text).not.toMatch(/operator_?id/i);
  });
});

describe("handleReport: who may act", () => {
  it("refuses anyone who is not an active admin, and writes nothing", async () => {
    const s = await resolvedCase();
    const r = await report("case", s.c.id);
    const before = await snapshot(s.c.id, r.id);
    const deleted = { ...(await makeAdmin()), deletedAt: new Date("2026-10-20T00:00:00Z") };
    for (const who of [await makeAdmin("active", "operator"), await makeAdmin("pending"), await makeAdmin("suspended"), deleted]) {
      expect(f.errorOf(await handleReport(t.db, who, { reportId: r.id, decision: "dismiss" }))).toBe("forbidden");
    }
    expect(await snapshot(s.c.id, r.id)).toEqual(before);
  });

  it("reads the admin's role and status from the database, not from the object it is given", async () => {
    const s = await resolvedCase();
    const r = await report("case", s.c.id);
    const admin = await makeAdmin();
    await t.sql("reset role");
    await t.sql(`update operators set status = 'suspended' where id = $1`, [admin.id]);
    await t.sql("set role app_server");
    expect(f.errorOf(await handleReport(t.db, admin, { reportId: r.id, decision: "dismiss" }))).toBe("forbidden");
    expect((await snapshot(s.c.id, r.id)).report).toBe("open");
  });

  it("checks the admin before the input", async () => {
    expect(f.errorOf(await handleReport(t.db, await makeAdmin("active", "operator"), { reportId: "x", decision: "y" }))).toBe("forbidden");
  });
});

describe("handleReport: the input", () => {
  it("names the field for a bad report id or an unknown decision, and writes nothing", async () => {
    const admin = await makeAdmin();
    const s = await resolvedCase();
    const r = await report("case", s.c.id);
    const before = await snapshot(s.c.id, r.id);
    const badId = await handleReport(t.db, admin, { reportId: "nope", decision: "dismiss" });
    expect(f.errorOf(badId)).toBe("invalid");
    expect(badId.ok === false && Object.keys(badId.detail ?? {})).toEqual(["reportId"]);
    for (const decision of ["", "approve", "uphold", undefined, 12, "DISMISS"]) {
      const result = await handleReport(t.db, admin, { reportId: r.id, decision });
      expect(f.errorOf(result)).toBe("invalid");
      expect(result.ok === false && Object.keys(result.detail ?? {})).toEqual(["decision"]);
    }
    expect(await snapshot(s.c.id, r.id)).toEqual(before);
  });

  it("answers not_found for a report that does not exist", async () => {
    expect(f.errorOf(await handleReport(t.db, await makeAdmin(), { reportId: UNKNOWN, decision: "dismiss" }))).toBe("not_found");
  });
});

describe("handleReport: dismiss and reviewed", () => {
  it.each([
    ["dismiss", "dismissed"],
    ["reviewed", "reviewed"],
  ] as const)("%s sets the report to %s and changes nothing else", async (decision, status) => {
    const admin = await makeAdmin();
    const s = await resolvedCase();
    const r = await report("case", s.c.id);
    const before = await snapshot(s.c.id);
    expect(f.unwrap(await handleReport(t.db, admin, { reportId: r.id, decision }))).toEqual({ status });
    const after = await snapshot(s.c.id, r.id);
    expect(after.report).toBe(status);
    expect({ ...after, report: null, audit: before.audit, moderation: before.moderation }).toEqual({ ...before, report: null });
  });

  it("writes one audit row and one moderation event, with ids and no reason", async () => {
    const admin = await makeAdmin();
    const s = await resolvedCase();
    const r = await report("case", s.c.id, { reason: "PLANTED_REASON_MARKER_55 is the whole complaint." });
    f.unwrap(await handleReport(t.db, admin, { reportId: r.id, decision: "dismiss" }));
    const audit = await t.sql(`select actor_type, actor_id, action, metadata from audit_log where action = 'report.handled' and target = $1`, [r.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: "operator", actor_id: admin.id });
    expect(JSON.stringify(audit[0].metadata)).toContain("dismiss");
    const events = await t.sql(`select target_type, target_id, "check", result, details from moderation_events where target_id = $1 and details ->> 'action' = 'dismiss'`, [s.c.id]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ target_type: "case", check: "manual", result: "pass" });
    expect(JSON.stringify([audit, events])).not.toContain("PLANTED_REASON_MARKER_55");
  });

  it("puts the moderation event on the argument for an argument report", async () => {
    const admin = await makeAdmin();
    const s = await resolvedCase();
    const r = await report("argument", s.losing.id);
    f.unwrap(await handleReport(t.db, admin, { reportId: r.id, decision: "reviewed" }));
    const events = await t.sql(`select target_type, target_id from moderation_events where target_id = $1 and details ->> 'action' = 'reviewed'`, [s.losing.id]);
    expect(events).toEqual([{ target_type: "argument", target_id: s.losing.id }]);
  });

  it("will not decide the same report twice", async () => {
    const admin = await makeAdmin();
    const s = await resolvedCase();
    const r = await report("case", s.c.id);
    f.unwrap(await handleReport(t.db, admin, { reportId: r.id, decision: "dismiss" }));
    const before = await snapshot(s.c.id, r.id);
    for (const decision of ["dismiss", "reviewed", "open_review"]) {
      expect(f.errorOf(await handleReport(t.db, admin, { reportId: r.id, decision }))).toBe("report_closed");
    }
    expect(await snapshot(s.c.id, r.id)).toEqual(before);
  });
});

describe("handleReport: open_review", () => {
  it("puts the verdict and the case under review, marks the report actioned, and leaves the appeal columns empty", async () => {
    const admin = await makeAdmin();
    const s = await resolvedCase();
    const r = await report("case", s.c.id);
    expect(f.unwrap(await handleReport(t.db, admin, { reportId: r.id, decision: "open_review" }))).toEqual({ status: "actioned" });
    const after = await snapshot(s.c.id, r.id);
    expect(after.case).toBe("under_appeal");
    expect(after.report).toBe("actioned");
    expect(after.verdicts).toEqual([{ status: "under_appeal", appealed_at: null, appeal_reason: null, appeal_outcome: null }]);
    expect(await f.count("audit_log where action = 'report.handled' and target = $1", [r.id])).toBe(1);
    expect(await f.count("audit_log where action = 'review.opened' and target = $1", [s.verdictId])).toBe(1);
  });

  it("works from a report on an argument of a resolved case", async () => {
    const admin = await makeAdmin();
    const s = await resolvedCase();
    const r = await report("argument", s.winning.id);
    f.unwrap(await handleReport(t.db, admin, { reportId: r.id, decision: "open_review" }));
    expect((await snapshot(s.c.id)).case).toBe("under_appeal");
  });

  it("leaves the winner's points pending, and the release job leaves them alone", async () => {
    const admin = await makeAdmin();
    const s = await resolvedCase();
    const r = await report("case", s.c.id);
    f.unwrap(await handleReport(t.db, admin, { reportId: r.id, decision: "open_review" }));
    await releaseDue(t.db, new Date(NOW.getTime() + 60 * DAY));
    const [event] = await t.sql(`select status, points from reputation_events where verdict_id = $1`, [s.verdictId]);
    expect(event).toEqual({ status: "pending", points: 10 });
  });

  it("stops the filing operator from appealing the same verdict afterwards", async () => {
    const admin = await makeAdmin();
    const s = await resolvedCase();
    const r = await report("case", s.c.id);
    f.unwrap(await handleReport(t.db, admin, { reportId: r.id, decision: "open_review" }));
    expect(f.errorOf(await appealVerdict(t.db, passGate, s.filer.operator, { caseId: s.c.id, reason: "The fix did not hold on the second run." }, new Date(NOW.getTime() + DAY)))).toBe("illegal_transition");
  });

  it.each([
    ["a case that is still open", async () => {
      const filer = await f.makeAgent();
      const c = await f.insertCase(filer.actor.agentId, { status: "open" });
      return { c, target: ["case", c.id] as const };
    }],
    ["an argument on a case that is still open", async () => {
      const filer = await f.makeAgent();
      const c = await f.insertCase(filer.actor.agentId, { status: "open" });
      const author = await f.makeAgent();
      const a = await f.insertArgument(c.id, author.actor.agentId, "active");
      return { c, target: ["argument", a.id] as const };
    }],
    ["a withdrawn case", async () => {
      const filer = await f.makeAgent();
      const c = await f.insertCase(filer.actor.agentId, { status: "withdrawn" });
      return { c, target: ["case", c.id] as const };
    }],
    ["a case whose verdict is already under appeal", async () => {
      const s = await resolvedCase();
      f.unwrap(await appealVerdict(t.db, passGate, s.filer.operator, { caseId: s.c.id, reason: "The fix did not hold on the second run." }, new Date(NOW.getTime() + DAY)));
      return { c: s.c, target: ["case", s.c.id] as const };
    }],
    ["a case whose verdict was overturned", async () => {
      const s = await resolvedCase();
      await t.sql(`update verdicts set status = 'overturned' where id = $1`, [s.verdictId]);
      await t.sql(`update cases set status = 'argued' where id = $1`, [s.c.id]);
      return { c: s.c, target: ["case", s.c.id] as const };
    }],
  ])("refuses %s, leaves the report open and writes nothing", async (_name, build) => {
    const admin = await makeAdmin();
    const { c, target } = await build();
    const r = await report(target[0], target[1]);
    const before = await snapshot(c.id, r.id);
    expect(f.errorOf(await handleReport(t.db, admin, { reportId: r.id, decision: "open_review" }))).toBe("illegal_transition");
    expect(await snapshot(c.id, r.id)).toEqual(before);
    expect(before.report).toBe("open");
  });

  it("lets such a report be dismissed or marked reviewed instead", async () => {
    const admin = await makeAdmin();
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const r = await report("case", c.id);
    expect(f.unwrap(await handleReport(t.db, admin, { reportId: r.id, decision: "reviewed" }))).toEqual({ status: "reviewed" });
  });
});

describe("handleReport: two at once", () => {
  it("lets exactly one of two administrators decide a report", async () => {
    const one = await makeAdmin();
    const two = await makeAdmin();
    const s = await resolvedCase();
    const r = await report("case", s.c.id);
    const results = await Promise.all([handleReport(t.db, one, { reportId: r.id, decision: "open_review" }), handleReport(t.db, two, { reportId: r.id, decision: "dismiss" })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(f.errorOf(results.find((result) => !result.ok)!)).toBe("report_closed");
    expect(await f.count("audit_log where action = 'report.handled' and target = $1", [r.id])).toBe(1);
  });

  it("lets two reports on one resolved case open only one review", async () => {
    const admin = await makeAdmin();
    const s = await resolvedCase();
    const first = await report("case", s.c.id);
    const second = await report("argument", s.winning.id);
    const results = await Promise.all([handleReport(t.db, admin, { reportId: first.id, decision: "open_review" }), handleReport(t.db, admin, { reportId: second.id, decision: "open_review" })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(f.errorOf(results.find((result) => !result.ok)!)).toBe("illegal_transition");
    expect(await f.count("audit_log where action = 'review.opened' and target = $1", [s.verdictId])).toBe(1);
  });
});
