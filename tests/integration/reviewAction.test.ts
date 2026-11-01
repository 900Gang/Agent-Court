import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operators, reports, type Operator } from "@/db/schema";
import { handleReportCore } from "@/lib/admin/reviewCore";
import type { ActionDeps } from "@/lib/dashboard/actionsCore";
import { describeError } from "@/lib/dashboard/messages";
import { issueVerdict } from "@/lib/services/verdictService";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const ORIGIN = "http://localhost:3000";
const NOW = new Date("2026-10-31T12:00:00.000Z");
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

async function makeOperator(role: "operator" | "admin" = "admin", status: "active" | "pending" | "suspended" = "active"): Promise<Operator> {
  const [row] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Operator", role, status }).returning();
  return row;
}

const deps = (operator: Operator | null, over: Partial<ActionDeps> = {}): ActionDeps => ({
  db: t.db,
  operator,
  headers: new Headers({ origin: ORIGIN }),
  expectedOrigin: ORIGIN,
  ...over,
});
const crossSite = { headers: new Headers({ origin: "https://evil.example" }) };
const noOrigin = { headers: new Headers() };

const run = (operator: Operator | null, input: { reportId: string; decision: string }, over: Partial<ActionDeps> = {}) => handleReportCore(deps(operator, over), input);

function codeOf(result: { ok: boolean; error?: { code: string } }): string {
  if (result.ok) throw new Error("expected a failure");
  return result.error?.code ?? "";
}

async function reportedCase() {
  const filer = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { status: "open" });
  const winner = await f.makeAgent();
  const argument = await f.insertArgument(c.id, winner.actor.agentId, "active");
  const issued = f.unwrap(await issueVerdict(t.db, passGate, filer.operator, { caseId: c.id, winningArgumentId: argument.id }, NOW));
  const reporter = await f.makeOperator();
  const [report] = await t.db.insert(reports).values({ reporterOperatorId: reporter.id, targetType: "case", targetId: c.id, reason: REASON }).returning();
  return { c, report, verdictId: issued.verdictId };
}

async function snapshot(caseId: string, reportId: string) {
  return {
    case: (await t.sql(`select status from cases where id = $1`, [caseId]))[0].status as string,
    verdict: (await t.sql(`select status from verdicts where case_id = $1`, [caseId]))[0].status as string,
    report: (await t.sql(`select status from reports where id = $1`, [reportId]))[0].status as string,
    audit: await f.count("audit_log where action in ('report.handled', 'review.opened')"),
  };
}

describe("handleReportCore: who may act", () => {
  it.each([
    ["a different origin", crossSite],
    ["no origin", noOrigin],
  ])("refuses %s before anything else, even for an admin", async (_label, over) => {
    const admin = await makeOperator();
    const s = await reportedCase();
    const before = await snapshot(s.c.id, s.report.id);
    expect(codeOf(await run(admin, { reportId: s.report.id, decision: "dismiss" }, over))).toBe("origin_mismatch");
    expect(codeOf(await run(null, { reportId: s.report.id, decision: "dismiss" }, over))).toBe("origin_mismatch");
    expect(await snapshot(s.c.id, s.report.id)).toEqual(before);
  });

  it("answers anyone who is not an active admin exactly as it answers a missing sign-in, and changes nothing", async () => {
    const deleted = { ...(await makeOperator()), deletedAt: new Date("2026-10-20T00:00:00Z") };
    const who: Array<[string, Operator | null]> = [
      ["nobody", null],
      ["an ordinary operator", await makeOperator("operator")],
      ["a pending admin", await makeOperator("admin", "pending")],
      ["a suspended admin", await makeOperator("admin", "suspended")],
      ["a deleted admin", deleted],
    ];
    const s = await reportedCase();
    const before = await snapshot(s.c.id, s.report.id);
    const answers = new Set<string>();
    for (const [label, operator] of who) {
      const result = await run(operator, { reportId: s.report.id, decision: "open_review" });
      expect(codeOf(result), label).toBe("not_signed_in");
      answers.add(JSON.stringify(result));
    }
    expect(answers.size).toBe(1);
    expect(await snapshot(s.c.id, s.report.id)).toEqual(before);
  });
});

describe("handleReportCore: what it does", () => {
  it.each([
    ["dismiss", "dismissed"],
    ["reviewed", "reviewed"],
    ["open_review", "actioned"],
  ])("%s answers with the report's new status %s", async (decision, status) => {
    const admin = await makeOperator();
    const s = await reportedCase();
    expect(await run(admin, { reportId: s.report.id, decision })).toEqual({ ok: true, value: { status } });
    expect((await snapshot(s.c.id, s.report.id)).report).toBe(status);
  });

  it("puts the case under review for open_review", async () => {
    const admin = await makeOperator();
    const s = await reportedCase();
    await run(admin, { reportId: s.report.id, decision: "open_review" });
    expect(await snapshot(s.c.id, s.report.id)).toMatchObject({ case: "under_appeal", verdict: "under_appeal" });
  });
});

describe("handleReportCore: what it refuses", () => {
  it("answers report_not_found for an unknown report", async () => {
    expect(codeOf(await run(await makeOperator(), { reportId: UNKNOWN, decision: "dismiss" }))).toBe("report_not_found");
  });

  it("answers report_not_open for a report that was already decided", async () => {
    const admin = await makeOperator();
    const s = await reportedCase();
    await run(admin, { reportId: s.report.id, decision: "dismiss" });
    const before = await snapshot(s.c.id, s.report.id);
    expect(codeOf(await run(admin, { reportId: s.report.id, decision: "open_review" }))).toBe("report_not_open");
    expect(await snapshot(s.c.id, s.report.id)).toEqual(before);
  });

  it("answers review_not_possible when the case cannot go under review", async () => {
    const admin = await makeOperator();
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const reporter = await f.makeOperator();
    const [report] = await t.db.insert(reports).values({ reporterOperatorId: reporter.id, targetType: "case", targetId: c.id, reason: REASON }).returning();
    expect(codeOf(await run(admin, { reportId: report.id, decision: "open_review" }))).toBe("review_not_possible");
    expect((await t.sql(`select status from reports where id = $1`, [report.id]))[0].status).toBe("open");
  });

  it("answers invalid for a bad id or decision, with fixed text", async () => {
    const admin = await makeOperator();
    const s = await reportedCase();
    expect(codeOf(await run(admin, { reportId: "nope", decision: "dismiss" }))).toBe("invalid");
    expect(codeOf(await run(admin, { reportId: s.report.id, decision: "approve" }))).toBe("invalid");
  });

  it("never puts what was submitted into the answer", async () => {
    const admin = await makeOperator();
    const result = await run(admin, { reportId: "<script>alert(1)</script>", decision: "<img src=x onerror=alert(1)>" });
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("<img");
  });
});

describe("the messages for the new codes", () => {
  it.each(["report_not_found", "report_not_open", "review_not_possible"])("%s has its own fixed message and hint", (code) => {
    const error = describeError(code);
    expect(error.code).toBe(code);
    expect(error.message.length).toBeGreaterThan(10);
    expect(error.hint.length).toBeGreaterThan(10);
  });
});
