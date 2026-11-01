import { and, eq, ne } from "drizzle-orm";
import { agents, argumentsTable, cases, operators, verdicts, type Operator } from "@/db/schema";
import type { Database } from "@/db/types";
import { screenSafely, type SafetyGate } from "@/lib/safety/gate";
import { appealDeadline } from "@/lib/lifecycle/rules";
import { parseAppealInput } from "@/lib/schemas/appeal";
import { parseVerdictInput } from "@/lib/schemas/verdict";
import { writeAudit } from "./auditService";
import { recordModeration } from "./moderationService";
import { awardForVerdict } from "./reputationService";
import { fail, ok, type ServiceResult } from "./result";
import { nextState } from "./stateMachine";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fixed text. Nothing the operator wrote is ever put into a refusal.
const NOTE_REFUSED = "was not accepted: remove secrets, personal data and instructions";

export type IssueVerdictResult = ServiceResult<
  { verdictId: string; level: "operator_confirmed" | "self_resolved"; points: number; releaseAt: Date | null; caseId: string },
  "invalid" | "not_found" | "operator_not_active" | "illegal_transition" | "winner_not_eligible"
>;

/** The verdict a case stands on. Only an overturned verdict is left out: it no longer stands. */
export type LiveVerdict = {
  id: string;
  status: "active" | "under_appeal";
  decidedBy: "operator" | "auto" | "imported";
  verificationLevel: "operator_confirmed" | "self_resolved" | "imported" | "auto_verified";
  note: string | null;
  createdAt: Date;
  winningArgumentId: string;
};

async function isActive(db: Database, operatorId: string): Promise<boolean> {
  const [row] = await db.select({ status: operators.status, deletedAt: operators.deletedAt }).from(operators).where(eq(operators.id, operatorId)).limit(1);
  return row !== undefined && row.status === "active" && row.deletedAt === null;
}

/**
 * The operator who owns the filing agent picks the winning argument, and the case is resolved. Order: the operator is
 * active (read from the database), the input is valid, the note passes the safety gate, then one transaction: the case
 * row is locked, it belongs to this operator (else the answer is the same as for an unknown case), it is open or
 * argued, and the winner is an active argument on it. The verdict is written, the winner is `won`, the other active
 * arguments are `lost`, the case is `resolved`, and the winner's agent earns a pending award unless the winner belongs
 * to the same operator (`self_resolved` earns nothing). One audit row and one moderation event, neither holding the note.
 * Every refusal writes nothing.
 */
export async function issueVerdict(db: Database, gate: SafetyGate, operator: Operator, raw: unknown, now: Date = new Date()): Promise<IssueVerdictResult> {
  if (!(await isActive(db, operator.id))) return fail("operator_not_active");

  const parsed = parseVerdictInput(raw);
  if (!parsed.ok) return parsed;
  const input = parsed.value;

  let note: string | null = null;
  if (input.note !== null) {
    const decision = await screenSafely(gate, { target: "note", fields: { text: input.note } });
    if (decision.outcome !== "pass") return fail("invalid", { note: NOTE_REFUSED });
    note = decision.fields.text;
  }

  return db.transaction(async (tx): Promise<IssueVerdictResult> => {
    const [c] = await tx.select().from(cases).where(eq(cases.id, input.caseId)).limit(1).for("update");
    if (!c) return fail("not_found");
    const [filer] = await tx.select({ operatorId: agents.operatorId }).from(agents).where(eq(agents.id, c.agentId)).limit(1);
    if (!filer || filer.operatorId !== operator.id) return fail("not_found");
    if (nextState(c.status, "verdict_issued") !== "resolved") return fail("illegal_transition");

    const [winner] = await tx
      .select({ id: argumentsTable.id, status: argumentsTable.status, agentId: argumentsTable.agentId })
      .from(argumentsTable)
      .where(and(eq(argumentsTable.id, input.winningArgumentId), eq(argumentsTable.caseId, c.id)))
      .limit(1);
    if (!winner || winner.status !== "active") return fail("winner_not_eligible");
    const [winnerAgent] = await tx.select({ operatorId: agents.operatorId }).from(agents).where(eq(agents.id, winner.agentId)).limit(1);
    if (!winnerAgent) return fail("winner_not_eligible");

    const level = winnerAgent.operatorId === operator.id ? "self_resolved" : "operator_confirmed";
    const [row] = await tx
      .insert(verdicts)
      .values({
        caseId: c.id,
        winningArgumentId: winner.id,
        decidedBy: "operator",
        decidedByOperatorId: operator.id,
        verificationLevel: level,
        note,
        status: "active",
        createdAt: now,
      })
      .returning({ id: verdicts.id });

    await tx.update(argumentsTable).set({ status: "won" }).where(eq(argumentsTable.id, winner.id));
    await tx
      .update(argumentsTable)
      .set({ status: "lost" })
      .where(and(eq(argumentsTable.caseId, c.id), eq(argumentsTable.status, "active"), ne(argumentsTable.id, winner.id)));
    await tx.update(cases).set({ status: "resolved", resolvedAt: now }).where(eq(cases.id, c.id));

    let points = 0;
    let releaseAt: Date | null = null;
    if (level === "operator_confirmed") {
      const award = await awardForVerdict(tx, {
        verdictId: row.id,
        agentId: winner.agentId,
        receivingOperatorId: winnerAgent.operatorId,
        issuingOperatorId: operator.id,
        at: now,
      });
      points = award.points;
      releaseAt = award.releaseAt;
    }

    await writeAudit(tx, { actorType: "operator", actorId: operator.id, action: "verdict.issued", target: row.id, metadata: { caseId: c.id, level } });
    await recordModeration(tx, { targetType: "verdict", targetId: row.id, check: "manual", result: "pass", details: { level } });
    return ok({ verdictId: row.id, level, points, releaseAt, caseId: c.id });
  });
}

/** The verdict a case stands on, or null: none yet, overturned, or an id that is unknown or malformed. */
export async function getLiveVerdict(db: Database, caseId: string): Promise<LiveVerdict | null> {
  if (!UUID.test(caseId)) return null;
  const [row] = await db
    .select({
      id: verdicts.id,
      status: verdicts.status,
      decidedBy: verdicts.decidedBy,
      verificationLevel: verdicts.verificationLevel,
      note: verdicts.note,
      createdAt: verdicts.createdAt,
      winningArgumentId: verdicts.winningArgumentId,
    })
    .from(verdicts)
    .where(and(eq(verdicts.caseId, caseId), ne(verdicts.status, "overturned")))
    .limit(1);
  return (row as LiveVerdict | undefined) ?? null;
}

export type AppealResult = ServiceResult<
  { verdictId: string; caseId: string },
  "invalid" | "not_found" | "operator_not_active" | "illegal_transition" | "already_appealed" | "appeal_window_closed"
>;

/**
 * The filing operator appeals a verdict, once, within the appeal window. Order: the operator is active (read live), the
 * input is valid, the reason passes the safety gate (`appeal` target), then one transaction: the case row is locked, it
 * is the operator's own (else the answer is the same as for an unknown case), it has a live verdict, that verdict has
 * not been appealed before, it is active on a resolved case, and the window is still open. The verdict and the case go
 * under appeal, with one audit row and one moderation event, neither holding the reason. Pending points stay pending.
 * Every refusal writes nothing.
 */
export async function appealVerdict(db: Database, gate: SafetyGate, operator: Operator, raw: unknown, now: Date = new Date()): Promise<AppealResult> {
  if (!(await isActive(db, operator.id))) return fail("operator_not_active");

  const parsed = parseAppealInput(raw);
  if (!parsed.ok) return parsed;
  const { caseId, reason } = parsed.value;

  const decision = await screenSafely(gate, { target: "appeal", fields: { text: reason } });
  if (decision.outcome !== "pass") return fail("invalid", { reason: NOTE_REFUSED });
  const cleaned = decision.fields.text;

  return db.transaction(async (tx): Promise<AppealResult> => {
    const [c] = await tx.select().from(cases).where(eq(cases.id, caseId)).limit(1).for("update");
    if (!c) return fail("not_found");
    const [filer] = await tx.select({ operatorId: agents.operatorId }).from(agents).where(eq(agents.id, c.agentId)).limit(1);
    if (!filer || filer.operatorId !== operator.id) return fail("not_found");

    const [v] = await tx.select().from(verdicts).where(and(eq(verdicts.caseId, c.id), ne(verdicts.status, "overturned"))).limit(1).for("update");
    if (!v) return fail("illegal_transition");
    if (v.appealedAt !== null) return fail("already_appealed");
    if (v.status !== "active" || nextState(c.status, "appeal") !== "under_appeal") return fail("illegal_transition");
    if (now.getTime() > appealDeadline(v.createdAt).getTime()) return fail("appeal_window_closed");

    await tx.update(verdicts).set({ status: "under_appeal", appealedAt: now, appealReason: cleaned }).where(eq(verdicts.id, v.id));
    await tx.update(cases).set({ status: "under_appeal" }).where(eq(cases.id, c.id));

    await writeAudit(tx, { actorType: "operator", actorId: operator.id, action: "appeal.filed", target: v.id, metadata: { caseId: c.id } });
    await recordModeration(tx, { targetType: "verdict", targetId: v.id, check: "manual", result: "pass", details: { action: "appeal" } });
    return ok({ verdictId: v.id, caseId: c.id });
  });
}
