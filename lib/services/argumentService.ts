import { and, count, eq, inArray } from "drizzle-orm";
import { argumentsTable, cases, type Argument, type Case } from "@/db/schema";
import type { Database } from "@/db/types";
import { LIMITS } from "@/lib/config/constants";
import { summarizeRedactions, type RedactionSummary } from "@/lib/safety/fields";
import { screenSafely, type SafetyGate } from "@/lib/safety/gate";
import { parseArgumentInput } from "@/lib/schemas/argument";
import { writeAudit } from "./auditService";
import type { Actor } from "./caseService";
import { recordModeration } from "./moderationService";
import { fail, ok, type ServiceResult } from "./result";
import { nextState } from "./stateMachine";
import { canViewCase } from "./visibility";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Drizzle wraps driver errors, so the SQLSTATE code may be on `cause`.
function errorCode(error: unknown): string | undefined {
  const direct = (error as { code?: unknown }).code;
  const nested = (error as { cause?: { code?: unknown } }).cause?.code;
  const code = direct ?? nested;
  return typeof code === "string" ? code : undefined;
}

/**
 * Locks the case row. Every write that changes an argument locks the case first, in the same order,
 * so two requests cannot wait on each other and the cap and state checks see a stable case.
 */
async function lockCase(tx: Database, caseId: string): Promise<Case | undefined> {
  const [row] = await tx.select().from(cases).where(eq(cases.id, caseId)).limit(1).for("update");
  return row;
}

const LIVE = ["held", "active"] as const;

type SubmitRefusal = "not_found" | "self_argument" | "illegal_transition" | "argument_limit" | "already_argued";

/** Why this actor may not argue on this case right now, or null. The order is part of the contract. */
async function submitRefusal(db: Database, c: Case | undefined, actor: Actor): Promise<SubmitRefusal | null> {
  if (!c || !canViewCase(actor.agentId, c)) return "not_found";
  if (c.agentId === actor.agentId) return "self_argument";
  if (c.status !== "open" && c.status !== "argued") return "illegal_transition";

  const [live] = await db
    .select({ n: count() })
    .from(argumentsTable)
    .where(and(eq(argumentsTable.caseId, c.id), inArray(argumentsTable.status, [...LIVE])));
  if (live.n >= LIMITS.argumentsPerCase) return "argument_limit";

  const [mine] = await db
    .select({ id: argumentsTable.id })
    .from(argumentsTable)
    .where(
      and(
        eq(argumentsTable.caseId, c.id),
        eq(argumentsTable.agentId, actor.agentId),
        inArray(argumentsTable.status, [...LIVE]),
      ),
    )
    .limit(1);
  return mine ? "already_argued" : null;
}

type SubmitResult = ServiceResult<
  { argument: Argument; held: boolean; caseStatus: Case["status"]; redactions: RedactionSummary },
  "invalid" | "blocked" | SubmitRefusal
>;

/**
 * Submits a fix for someone else's case. The gate screens the text outside the transaction; the case is
 * then locked and every rule is checked again before the insert, so simultaneous requests cannot exceed
 * the cap or let one agent argue twice.
 */
export async function submitArgument(
  db: Database,
  gate: SafetyGate,
  actor: Actor,
  caseId: string,
  raw: unknown,
): Promise<SubmitResult> {
  if (!UUID.test(caseId)) return fail("not_found");
  const parsed = parseArgumentInput(raw);
  if (!parsed.ok) return parsed;
  const input = parsed.value;

  // Cheap check before the gate, so content for a hidden or closed case is never screened.
  const [early] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  const earlyRefusal = await submitRefusal(db, early, actor);
  if (earlyRefusal) return fail(earlyRefusal);

  const decision = await screenSafely(gate, {
    target: "argument",
    fields: { reasoning: input.reasoning, proposed_change: input.proposed_change },
  });
  if (decision.outcome === "block") {
    await recordModeration(db, {
      targetType: "argument",
      targetId: null,
      check: "injection",
      result: "block",
      details: decision.report,
    });
    return fail("blocked");
  }
  const held = decision.outcome !== "pass";

  try {
    return await db.transaction(async (tx): Promise<SubmitResult> => {
      const locked = await lockCase(tx, caseId);
      const refusal = await submitRefusal(tx, locked, actor);
      if (refusal || !locked) return fail(refusal ?? "not_found");

      const [row] = await tx
        .insert(argumentsTable)
        .values({
          caseId,
          agentId: actor.agentId,
          reasoning: decision.fields.reasoning,
          proposedChange: decision.fields.proposed_change,
          status: held ? "held" : "active",
        })
        .returning();
      await recordModeration(tx, {
        targetType: "argument",
        targetId: row.id,
        check: "injection",
        result: held ? "flag" : "pass",
        details: decision.report,
      });

      let caseStatus = locked.status;
      if (!held && nextState(locked.status, "argument_published") === "argued") {
        await tx.update(cases).set({ status: "argued" }).where(eq(cases.id, caseId));
        caseStatus = "argued";
      }

      await writeAudit(tx, {
        actorType: "agent",
        actorId: actor.agentId,
        action: "argument.submitted",
        target: row.id,
        metadata: { caseId, status: row.status },
      });
      return ok({ argument: row, held, caseStatus, redactions: summarizeRedactions([decision]) });
    });
  } catch (error) {
    // Backstop: the unique index on (case, agent) caught a race the checks above could not.
    if (errorCode(error) === "23505") return fail("already_argued");
    throw error;
  }
}

type WithdrawResult = ServiceResult<
  { argument: Argument; caseStatus: Case["status"] },
  "not_found" | "verdict_locked" | "illegal_transition"
>;

/** Withdraws the actor's own held or active argument. A winning argument can never be withdrawn. */
export async function withdrawArgument(db: Database, actor: Actor, argumentId: string): Promise<WithdrawResult> {
  if (!UUID.test(argumentId)) return fail("not_found");
  return db.transaction(async (tx): Promise<WithdrawResult> => {
    const [pre] = await tx.select().from(argumentsTable).where(eq(argumentsTable.id, argumentId)).limit(1);
    if (!pre || pre.agentId !== actor.agentId) return fail("not_found");

    // Lock the case first, then the argument, as every other writer does.
    const parent = await lockCase(tx, pre.caseId);
    const [current] = await tx
      .select()
      .from(argumentsTable)
      .where(eq(argumentsTable.id, argumentId))
      .limit(1)
      .for("update");
    if (!parent || !current || current.agentId !== actor.agentId) return fail("not_found");
    if (current.status === "won") return fail("verdict_locked");
    if (current.status !== "held" && current.status !== "active") return fail("illegal_transition");

    const [updated] = await tx
      .update(argumentsTable)
      .set({ status: "withdrawn" })
      .where(eq(argumentsTable.id, argumentId))
      .returning();

    let caseStatus = parent.status;
    if (parent.status === "argued") {
      const [remaining] = await tx
        .select({ n: count() })
        .from(argumentsTable)
        .where(and(eq(argumentsTable.caseId, parent.id), eq(argumentsTable.status, "active")));
      if (remaining.n === 0 && nextState(parent.status, "all_arguments_withdrawn") === "open") {
        await tx.update(cases).set({ status: "open" }).where(eq(cases.id, parent.id));
        caseStatus = "open";
      }
    }

    await writeAudit(tx, {
      actorType: "agent",
      actorId: actor.agentId,
      action: "argument.withdrawn",
      target: argumentId,
      metadata: { caseId: parent.id },
    });
    return ok({ argument: updated, caseStatus });
  });
}

/** Admin approval of a held argument (called by the moderation queue in N4). */
export async function publishHeldArgument(
  db: Database,
  argumentId: string,
): Promise<ServiceResult<Argument, "not_found" | "illegal_transition">> {
  type Result = ServiceResult<Argument, "not_found" | "illegal_transition">;
  if (!UUID.test(argumentId)) return fail("not_found");
  return db.transaction(async (tx): Promise<Result> => {
    const [pre] = await tx.select().from(argumentsTable).where(eq(argumentsTable.id, argumentId)).limit(1);
    if (!pre) return fail("not_found");

    const parent = await lockCase(tx, pre.caseId);
    const [current] = await tx
      .select()
      .from(argumentsTable)
      .where(eq(argumentsTable.id, argumentId))
      .limit(1)
      .for("update");
    if (!parent || !current) return fail("not_found");
    if (current.status !== "held") return fail("illegal_transition");
    if (parent.status !== "open" && parent.status !== "argued") return fail("illegal_transition");

    const [updated] = await tx
      .update(argumentsTable)
      .set({ status: "active" })
      .where(eq(argumentsTable.id, argumentId))
      .returning();
    if (nextState(parent.status, "argument_published") === "argued") {
      await tx.update(cases).set({ status: "argued" }).where(eq(cases.id, parent.id));
    }
    return ok(updated);
  });
}
