import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import { argumentsTable, cases, operators, reports, verdicts, type Case, type Operator } from "@/db/schema";
import type { Database } from "@/db/types";
import { isActiveAdmin } from "@/lib/auth/isActiveAdmin";
import { writeAudit } from "./auditService";
import { recordModeration } from "./moderationService";
import { getPendingPointsForVerdicts, reverseForVerdict } from "./reputationService";
import { fail, ok, type ServiceResult } from "./result";
import { nextState } from "./stateMachine";

// What an administrator reads and decides about reports and verdicts under review (N8b). Lists hold no reporter and no
// operator id. Free text (a report's reason, an appeal's reason) is returned as stored and is shown as text only.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const clampLimit = (limit: number | undefined) => Math.max(1, Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT));

export type ReportListItem = {
  id: string;
  createdAt: Date;
  targetType: "case" | "argument";
  targetId: string;
  /** The case the target belongs to, or null when the target no longer exists. */
  caseId: string | null;
  caseTitle: string | null;
  caseStatus: Case["status"] | null;
  /** A review can be opened: the case is resolved and its verdict is active. */
  canOpenReview: boolean;
  reason: string;
};

/** Open reports on cases and arguments, oldest first, with the case each belongs to. At most `limit`, and a flag when cut. */
export async function listReports(db: Database, options: { limit?: number } = {}): Promise<{ reports: ReportListItem[]; truncated: boolean }> {
  const limit = clampLimit(options.limit);
  const rows = await db
    .select()
    .from(reports)
    .where(and(eq(reports.status, "open"), inArray(reports.targetType, ["case", "argument"])))
    .orderBy(asc(reports.createdAt), asc(reports.id))
    .limit(limit + 1);
  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);

  const argumentIds = page.filter((row) => row.targetType === "argument").map((row) => row.targetId);
  const argumentCase = new Map<string, string>();
  if (argumentIds.length > 0) {
    const found = await db.select({ id: argumentsTable.id, caseId: argumentsTable.caseId }).from(argumentsTable).where(inArray(argumentsTable.id, argumentIds));
    for (const row of found) argumentCase.set(row.id, row.caseId);
  }

  const caseIds = [
    ...new Set(
      page
        .map((row) => (row.targetType === "case" ? row.targetId : argumentCase.get(row.targetId)))
        .filter((id): id is string => id !== undefined),
    ),
  ];
  const caseRows = new Map<string, { title: string; status: Case["status"] }>();
  const verdictStatus = new Map<string, string>();
  if (caseIds.length > 0) {
    const found = await db.select({ id: cases.id, title: cases.title, status: cases.status }).from(cases).where(inArray(cases.id, caseIds));
    for (const row of found) caseRows.set(row.id, { title: row.title, status: row.status });
    const live = await db
      .select({ caseId: verdicts.caseId, status: verdicts.status })
      .from(verdicts)
      .where(and(inArray(verdicts.caseId, caseIds), ne(verdicts.status, "overturned")));
    for (const row of live) verdictStatus.set(row.caseId, row.status);
  }

  return {
    truncated,
    reports: page.map((row) => {
      const caseId = row.targetType === "case" ? row.targetId : (argumentCase.get(row.targetId) ?? null);
      const found = caseId === null ? undefined : caseRows.get(caseId);
      return {
        id: row.id,
        createdAt: row.createdAt,
        targetType: row.targetType as "case" | "argument",
        targetId: row.targetId,
        caseId: found && caseId !== null ? caseId : null,
        caseTitle: found?.title ?? null,
        caseStatus: found?.status ?? null,
        canOpenReview: found !== undefined && caseId !== null && found.status === "resolved" && verdictStatus.get(caseId) === "active",
        reason: row.reason,
      };
    }),
  };
}

export type AppealListItem = {
  caseId: string;
  caseTitle: string;
  verdictId: string;
  verdictAt: Date;
  /** `appeal` when the filing operator appealed, `review` when an administrator opened it from a report. */
  origin: "appeal" | "review";
  appealReason: string | null;
  pendingPoints: number;
};

/** Verdicts that are under appeal or under review, oldest first, with the points waiting on each. */
export async function listAppeals(db: Database, options: { limit?: number } = {}): Promise<{ appeals: AppealListItem[]; truncated: boolean }> {
  const limit = clampLimit(options.limit);
  const rows = await db
    .select({
      caseId: cases.id,
      caseTitle: cases.title,
      verdictId: verdicts.id,
      verdictAt: verdicts.createdAt,
      appealedAt: verdicts.appealedAt,
      appealReason: verdicts.appealReason,
    })
    .from(verdicts)
    .innerJoin(cases, eq(cases.id, verdicts.caseId))
    .where(eq(verdicts.status, "under_appeal"))
    .orderBy(asc(verdicts.createdAt), asc(verdicts.id))
    .limit(limit + 1);
  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);
  const pending = await getPendingPointsForVerdicts(db, page.map((row) => row.verdictId));
  return {
    truncated,
    appeals: page.map((row) => ({
      caseId: row.caseId,
      caseTitle: row.caseTitle,
      verdictId: row.verdictId,
      verdictAt: row.verdictAt,
      origin: row.appealedAt === null ? "review" : "appeal",
      appealReason: row.appealedAt === null ? null : row.appealReason,
      pendingPoints: pending.get(row.verdictId) ?? 0,
    })),
  };
}

const DECISIONS = ["dismiss", "reviewed", "open_review"] as const;
type Decision = (typeof DECISIONS)[number];

export type HandleReportResult = ServiceResult<
  { status: "dismissed" | "reviewed" | "actioned" },
  "invalid" | "not_found" | "forbidden" | "report_closed" | "illegal_transition"
>;

async function isLiveAdmin(db: Database, operatorId: string): Promise<boolean> {
  const [row] = await db.select({ role: operators.role, status: operators.status, deletedAt: operators.deletedAt }).from(operators).where(eq(operators.id, operatorId)).limit(1);
  return row !== undefined && row.role === "admin" && row.status === "active" && row.deletedAt === null;
}

/**
 * An administrator's decision on one open report: dismiss it, mark it reviewed, or open a review of the verdict it is
 * about. Order: the admin is active and an admin (the object and the database both say so), the input is valid, then one
 * transaction: the report is locked and still open; for a review, the case is locked, it is resolved and its verdict is
 * active, and both go under review. Every refusal writes nothing. Audit and moderation rows hold ids and the decision,
 * never what the reporter wrote.
 */
export async function handleReport(db: Database, admin: Operator, raw: unknown): Promise<HandleReportResult> {
  if (!isActiveAdmin(admin) || !(await isLiveAdmin(db, admin.id))) return fail("forbidden");

  const input = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const { reportId, decision } = input;
  const detail: Record<string, string> = {};
  if (typeof reportId !== "string" || !UUID.test(reportId)) detail.reportId = "must be a report id";
  if (typeof decision !== "string" || !(DECISIONS as readonly string[]).includes(decision)) detail.decision = "must be dismiss, reviewed or open_review";
  if (Object.keys(detail).length > 0) return fail("invalid", detail);
  const id = reportId as string;
  const choice = decision as Decision;

  return db.transaction(async (tx): Promise<HandleReportResult> => {
    const [report] = await tx.select().from(reports).where(eq(reports.id, id)).limit(1).for("update");
    if (!report) return fail("not_found");
    if (report.status !== "open") return fail("report_closed");

    let verdictId: string | null = null;
    let caseId: string | null = null;
    if (choice === "open_review") {
      if (report.targetType === "case") {
        caseId = report.targetId;
      } else if (report.targetType === "argument") {
        const [row] = await tx.select({ caseId: argumentsTable.caseId }).from(argumentsTable).where(eq(argumentsTable.id, report.targetId)).limit(1);
        caseId = row?.caseId ?? null;
      }
      if (caseId === null) return fail("illegal_transition");
      const [c] = await tx.select().from(cases).where(eq(cases.id, caseId)).limit(1).for("update");
      if (!c) return fail("illegal_transition");
      const [v] = await tx.select().from(verdicts).where(and(eq(verdicts.caseId, c.id), ne(verdicts.status, "overturned"))).limit(1).for("update");
      if (!v || v.status !== "active" || nextState(c.status, "review_opened") !== "under_appeal") return fail("illegal_transition");
      await tx.update(verdicts).set({ status: "under_appeal" }).where(eq(verdicts.id, v.id));
      await tx.update(cases).set({ status: "under_appeal" }).where(eq(cases.id, c.id));
      verdictId = v.id;
    }

    const status = choice === "dismiss" ? "dismissed" : choice === "reviewed" ? "reviewed" : "actioned";
    await tx.update(reports).set({ status }).where(eq(reports.id, report.id));

    await writeAudit(tx, { actorType: "operator", actorId: admin.id, action: "report.handled", target: report.id, metadata: { decision: choice } });
    if (verdictId !== null && caseId !== null) {
      await writeAudit(tx, { actorType: "operator", actorId: admin.id, action: "review.opened", target: verdictId, metadata: { caseId, reportId: report.id } });
    }
    await recordModeration(tx, {
      targetType: report.targetType === "argument" ? "argument" : "case",
      targetId: report.targetId,
      check: "manual",
      result: "pass",
      details: { action: choice },
    });
    return ok({ status });
  });
}

const REVIEW_DECISIONS = ["uphold", "overturn"] as const;
type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export type DecideReviewResult = ServiceResult<
  { outcome: "upheld" | "overturned" },
  "invalid" | "forbidden" | "not_found" | "illegal_transition"
>;

/**
 * An administrator decides a verdict that is under appeal or under review. Order: the admin is active and an admin (the
 * object and the database both say so), the input is valid, then one transaction: the case row is locked, the case and
 * its live verdict are both under appeal. Upholding makes the verdict active and the case resolved again; the points stay
 * pending and the release job pays them at the end of the window. Overturning makes the verdict history, the winning
 * argument overturned, the arguments that lost active again (except one whose agent has argued again since), the case
 * argued (or open when nothing active is left), and takes the points back. Every refusal writes nothing, and no text is
 * written to the audit or moderation rows.
 */
export async function decideReview(db: Database, admin: Operator, raw: unknown, now: Date = new Date()): Promise<DecideReviewResult> {
  if (!isActiveAdmin(admin) || !(await isLiveAdmin(db, admin.id))) return fail("forbidden");

  const input = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const { caseId, decision } = input;
  const detail: Record<string, string> = {};
  if (typeof caseId !== "string" || !UUID.test(caseId)) detail.caseId = "must be a case id";
  if (typeof decision !== "string" || !(REVIEW_DECISIONS as readonly string[]).includes(decision)) detail.decision = "must be uphold or overturn";
  if (Object.keys(detail).length > 0) return fail("invalid", detail);
  const id = caseId as string;
  const choice = decision as ReviewDecision;

  return db.transaction(async (tx): Promise<DecideReviewResult> => {
    const [c] = await tx.select().from(cases).where(eq(cases.id, id)).limit(1).for("update");
    if (!c) return fail("not_found");
    const [v] = await tx.select().from(verdicts).where(and(eq(verdicts.caseId, c.id), ne(verdicts.status, "overturned"))).limit(1).for("update");
    if (!v || c.status !== "under_appeal" || v.status !== "under_appeal") return fail("illegal_transition");

    if (choice === "uphold") {
      if (nextState(c.status, "upheld") !== "resolved") return fail("illegal_transition");
      await tx.update(verdicts).set({ status: "active", appealOutcome: "upheld", appealResolvedAt: now }).where(eq(verdicts.id, v.id));
      await tx.update(cases).set({ status: "resolved" }).where(eq(cases.id, c.id));
      await writeAudit(tx, { actorType: "operator", actorId: admin.id, action: "verdict.upheld", target: v.id, metadata: { caseId: c.id } });
      await recordModeration(tx, { targetType: "verdict", targetId: v.id, check: "manual", result: "pass", details: { action: "uphold" } });
      return ok({ outcome: "upheld" });
    }

    const afterOverturn = nextState(c.status, "overturned");
    if (afterOverturn !== "argued") return fail("illegal_transition");
    await tx.update(verdicts).set({ status: "overturned", appealOutcome: "overturned", appealResolvedAt: now }).where(eq(verdicts.id, v.id));
    await tx.update(argumentsTable).set({ status: "overturned" }).where(eq(argumentsTable.id, v.winningArgumentId));

    // The arguments that lost go back to active, oldest first, one per agent, unless the agent already has a live one.
    const live = await tx
      .select({ agentId: argumentsTable.agentId })
      .from(argumentsTable)
      .where(and(eq(argumentsTable.caseId, c.id), inArray(argumentsTable.status, ["held", "active"])));
    const taken = new Set(live.map((row) => row.agentId));
    const lost = await tx
      .select({ id: argumentsTable.id, agentId: argumentsTable.agentId })
      .from(argumentsTable)
      .where(and(eq(argumentsTable.caseId, c.id), eq(argumentsTable.status, "lost")))
      .orderBy(asc(argumentsTable.createdAt), asc(argumentsTable.id));
    let restored = 0;
    for (const row of lost) {
      if (taken.has(row.agentId)) continue;
      await tx.update(argumentsTable).set({ status: "active" }).where(eq(argumentsTable.id, row.id));
      taken.add(row.agentId);
      restored += 1;
    }

    const [{ n }] = await tx
      .select({ n: count() })
      .from(argumentsTable)
      .where(and(eq(argumentsTable.caseId, c.id), eq(argumentsTable.status, "active")));
    const emptied = n === 0 && nextState("argued", "all_arguments_withdrawn") === "open";
    const finalState = emptied ? "open" : "argued";
    await tx.update(cases).set({ status: finalState, resolvedAt: null }).where(eq(cases.id, c.id));

    await reverseForVerdict(tx, v.id);
    await writeAudit(tx, { actorType: "operator", actorId: admin.id, action: "verdict.overturned", target: v.id, metadata: { caseId: c.id, restored } });
    await recordModeration(tx, { targetType: "verdict", targetId: v.id, check: "manual", result: "pass", details: { action: "overturn" } });
    return ok({ outcome: "overturned" });
  });
}
