import { and, count, eq, gt } from "drizzle-orm";
import { argumentsTable, cases, operators, reports, type Operator } from "@/db/schema";
import type { Database } from "@/db/types";
import { REPORT } from "@/lib/config/constants";
import { screenSafely, type SafetyGate } from "@/lib/safety/gate";
import { normalizeText } from "@/lib/safety/normalize";
import { writeAudit } from "./auditService";
import { fail, ok, type ServiceResult } from "./result";
import { canViewArgument, canViewCase } from "./visibility";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

// Fixed text. Nothing the reporter wrote is ever put into a refusal.
const REFUSED = "was not accepted: remove secrets, personal data and instructions";
const REASON_LENGTH = `must be ${REPORT.minReason} to ${REPORT.maxReason} characters`;

type ReportInput = { targetType: "case" | "argument"; targetId: string; reason: string };

export type CreateReportResult = ServiceResult<
  { reportId: string; caseId: string },
  "invalid" | "not_found" | "duplicate" | "limit_reached" | "operator_not_active"
>;

function parseReport(raw: unknown): ServiceResult<ReportInput, "invalid"> {
  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const { targetType, targetId, reason } = input;
  if (targetType !== "case" && targetType !== "argument") return fail("invalid", { targetType: "must be case or argument" });
  if (typeof reason !== "string") return fail("invalid", { reason: REASON_LENGTH });
  // The length is measured on the text the gate will see, so invisible characters cannot pad a reason.
  const cleaned = normalizeText(reason).text.trim();
  if (cleaned.length < REPORT.minReason || cleaned.length > REPORT.maxReason) return fail("invalid", { reason: REASON_LENGTH });
  return ok({ targetType, targetId: typeof targetId === "string" ? targetId : "", reason: cleaned });
}

async function isActive(db: Database, operatorId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: operators.status, deletedAt: operators.deletedAt })
    .from(operators)
    .where(eq(operators.id, operatorId))
    .limit(1);
  return row !== undefined && row.status === "active" && row.deletedAt === null;
}

/**
 * The case a report is about, if a visitor could see the target. Hidden and unknown targets both give null, so a
 * reporter cannot learn that a held item exists. The case comes from the database, never from the form.
 */
async function findPublicTarget(db: Database, input: ReportInput): Promise<{ caseId: string } | null> {
  if (!UUID.test(input.targetId)) return null;
  if (input.targetType === "case") {
    const [row] = await db
      .select({ id: cases.id, agentId: cases.agentId, status: cases.status })
      .from(cases)
      .where(eq(cases.id, input.targetId))
      .limit(1);
    return row && canViewCase(null, row) ? { caseId: row.id } : null;
  }
  const [row] = await db
    .select({
      caseId: argumentsTable.caseId,
      agentId: argumentsTable.agentId,
      status: argumentsTable.status,
      caseAgentId: cases.agentId,
      caseStatus: cases.status,
    })
    .from(argumentsTable)
    .innerJoin(cases, eq(cases.id, argumentsTable.caseId))
    .where(eq(argumentsTable.id, input.targetId))
    .limit(1);
  if (!row) return null;
  const visible = canViewCase(null, { agentId: row.caseAgentId, status: row.caseStatus }) && canViewArgument(null, row);
  return visible ? { caseId: row.caseId } : null;
}

/**
 * Records a report on a public case or argument. Checks, in order: the operator is active (read from the
 * database), the input is valid, the target is public, the reason passes the safety gate, the operator has no open
 * report on the same target, and fewer than the daily limit of reports in the last 24 hours. The last three
 * checks and the writes run in one transaction with the operator row locked, so simultaneous requests cannot
 * slip past the limits. Every refusal writes nothing.
 */
export async function createReport(
  db: Database,
  gate: SafetyGate,
  operator: Operator,
  raw: unknown,
  now: Date = new Date(),
): Promise<CreateReportResult> {
  if (!(await isActive(db, operator.id))) return fail("operator_not_active");

  const parsed = parseReport(raw);
  if (!parsed.ok) return parsed;
  const input = parsed.value;

  const target = await findPublicTarget(db, input);
  if (!target) return fail("not_found");

  // Screened outside the transaction, so a slow gate holds no locks.
  const decision = await screenSafely(gate, { target: "report", fields: { reason: input.reason } });
  if (decision.outcome !== "pass") return fail("invalid", { reason: REFUSED });

  return db.transaction(async (tx): Promise<CreateReportResult> => {
    const [current] = await tx
      .select({ status: operators.status, deletedAt: operators.deletedAt })
      .from(operators)
      .where(eq(operators.id, operator.id))
      .limit(1)
      .for("update");
    if (!current || current.status !== "active" || current.deletedAt !== null) return fail("operator_not_active");

    const [open] = await tx
      .select({ id: reports.id })
      .from(reports)
      .where(
        and(
          eq(reports.reporterOperatorId, operator.id),
          eq(reports.targetType, input.targetType),
          eq(reports.targetId, input.targetId),
          eq(reports.status, "open"),
        ),
      )
      .limit(1);
    if (open) return fail("duplicate");

    const [{ total }] = await tx
      .select({ total: count() })
      .from(reports)
      .where(and(eq(reports.reporterOperatorId, operator.id), gt(reports.createdAt, new Date(now.getTime() - DAY_MS))));
    if (total >= REPORT.perOperatorPerDay) return fail("limit_reached");

    const [row] = await tx
      .insert(reports)
      .values({
        reporterOperatorId: operator.id,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: decision.fields.reason,
        createdAt: now,
      })
      .returning({ id: reports.id });
    await writeAudit(tx, {
      actorType: "operator",
      actorId: operator.id,
      action: "report.created",
      target: row.id,
      metadata: { targetType: input.targetType },
    });
    return ok({ reportId: row.id, caseId: target.caseId });
  });
}
