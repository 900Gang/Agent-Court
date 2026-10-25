import { and, count, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { agents, argumentsTable, cases, evidence, type Case, type Evidence } from "@/db/schema";
import type { Database } from "@/db/types";
import { LIMITS, PUBLIC_CASE_STATUSES } from "@/lib/config/constants";
import { applyCaseFields, caseGateFields, summarizeRedactions, type RedactionSummary } from "@/lib/safety/fields";
import { screenSafely, type GateDecision, type SafetyGate } from "@/lib/safety/gate";
import { parseCaseInput } from "@/lib/schemas/case";
import { parseEvidenceInput } from "@/lib/schemas/evidence";
import { encodeCursor, type ListQuery } from "@/lib/schemas/pagination";
import type { CaseDetail, CaseListItem } from "@/lib/serializers/toAgentView";
import { writeAudit } from "./auditService";
import { recordModeration } from "./moderationService";
import { fail, ok, type ServiceResult } from "./result";
import { nextState } from "./stateMachine";
import { canViewArgument, canViewCase, canViewEvidence } from "./visibility";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The agent making a request, as established by API key authentication. */
export type Actor = { agentId: string; operatorId: string };

async function readCase(db: Database, caseId: string, lock = false): Promise<Case | undefined> {
  const query = db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  if (lock) {
    const [row] = await query.for("update");
    return row;
  }
  const [row] = await query;
  return row;
}

async function recordBlock(db: Database, targetType: "case" | "evidence", decision: GateDecision): Promise<void> {
  await recordModeration(db, {
    targetType,
    targetId: null,
    check: "injection",
    result: "block",
    details: decision.report,
  });
}

type FileCaseResult = ServiceResult<
  { case: Case; evidence: Evidence[]; held: boolean; redactions: RedactionSummary },
  "invalid" | "blocked"
>;

/**
 * Files a case. The gate screens the text first (outside the transaction, so a slow gate holds no locks);
 * then the case, its evidence, the moderation events and the audit row are written together.
 * Blocked content is never stored: only a moderation event remains.
 */
export async function fileCase(
  db: Database,
  gate: SafetyGate,
  actor: Actor,
  raw: unknown,
  now: Date = new Date(),
): Promise<FileCaseResult> {
  const parsed = parseCaseInput(raw);
  if (!parsed.ok) return parsed;
  const input = parsed.value;

  const caseDecision = await screenSafely(gate, { target: "case", fields: caseGateFields(input) });
  const evidenceDecisions: GateDecision[] = [];
  for (const item of input.evidence) {
    evidenceDecisions.push(
      await screenSafely(gate, { target: "evidence", fields: { text: item.text }, context: { evidenceKind: item.kind } }),
    );
  }

  let blocked = false;
  if (caseDecision.outcome === "block") {
    blocked = true;
    await recordBlock(db, "case", caseDecision);
  }
  for (const decision of evidenceDecisions) {
    if (decision.outcome === "block") {
      blocked = true;
      await recordBlock(db, "evidence", decision);
    }
  }
  if (blocked) return fail("blocked");

  // A dropped tag means the gate changed something it should not have had to: a person looks before it goes public.
  const applied = applyCaseFields(input, caseDecision.fields);
  const held = caseDecision.outcome !== "pass" || applied.droppedTags > 0;

  return db.transaction(async (tx): Promise<FileCaseResult> => {
    const [row] = await tx
      .insert(cases)
      .values({
        agentId: actor.agentId,
        title: applied.title,
        summary: applied.summary,
        expected: applied.expected,
        actual: applied.actual,
        environment: applied.environment,
        tags: applied.tags,
        status: held ? "held" : "open",
        publishedAt: held ? null : now,
      })
      .returning();
    await recordModeration(tx, {
      targetType: "case",
      targetId: row.id,
      check: "injection",
      result: held ? "flag" : "pass",
      details: applied.droppedTags > 0 ? { ...caseDecision.report, droppedTags: applied.droppedTags } : caseDecision.report,
    });

    const stored: Evidence[] = [];
    for (const [index, item] of input.evidence.entries()) {
      const decision = evidenceDecisions[index];
      const [saved] = await tx
        .insert(evidence)
        .values({
          caseId: row.id,
          kind: item.kind,
          redactedText: decision.fields.text,
          status: held || decision.outcome !== "pass" ? "held" : "active",
        })
        .returning();
      stored.push(saved);
      await recordModeration(tx, {
        targetType: "evidence",
        targetId: saved.id,
        check: "injection",
        result: decision.outcome === "pass" ? "pass" : "flag",
        details: decision.report,
      });
    }

    await writeAudit(tx, {
      actorType: "agent",
      actorId: actor.agentId,
      action: "case.filed",
      target: row.id,
      metadata: { caseId: row.id, status: row.status, evidenceCount: stored.length },
    });
    return ok({
      case: row,
      evidence: stored,
      held,
      redactions: summarizeRedactions([caseDecision, ...evidenceDecisions]),
    });
  });
}

type AddEvidenceError = "invalid" | "blocked" | "not_found" | "illegal_transition" | "limit_reached";
type AddEvidenceValue = { evidence: Evidence; held: boolean; redactions: RedactionSummary };

function evidenceGuard(
  c: Case | undefined,
  actor: Actor,
  existing: number,
): "not_found" | "illegal_transition" | "limit_reached" | null {
  // Only the filer may add evidence; everyone else, and rejected cases, look like missing ones.
  if (!c || c.agentId !== actor.agentId || c.status === "rejected") return "not_found";
  if (c.status !== "held" && c.status !== "open" && c.status !== "argued") return "illegal_transition";
  if (existing >= LIMITS.evidencePerCase) return "limit_reached";
  return null;
}

async function evidenceCount(db: Database, caseId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(evidence).where(eq(evidence.caseId, caseId));
  return row.n;
}

/** Adds evidence to the actor's own case. Evidence on a held case stays held whatever the gate says. */
export async function addEvidence(
  db: Database,
  gate: SafetyGate,
  actor: Actor,
  caseId: string,
  raw: unknown,
): Promise<ServiceResult<AddEvidenceValue, AddEvidenceError>> {
  type Result = ServiceResult<AddEvidenceValue, AddEvidenceError>;
  if (!UUID.test(caseId)) return fail("not_found");
  const parsed = parseEvidenceInput(raw);
  if (!parsed.ok) return parsed;
  const input = parsed.value;

  // Cheap check before the gate, so content for a hidden or closed case is never screened.
  const early = evidenceGuard(await readCase(db, caseId), actor, await evidenceCount(db, caseId));
  if (early) return fail(early);

  const decision = await screenSafely(gate, {
    target: "evidence",
    fields: { text: input.text },
    context: { evidenceKind: input.kind },
  });
  if (decision.outcome === "block") {
    await recordBlock(db, "evidence", decision);
    return fail("blocked");
  }

  return db.transaction(async (tx): Promise<Result> => {
    const locked = await readCase(tx, caseId, true);
    const problem = evidenceGuard(locked, actor, await evidenceCount(tx, caseId));
    if (problem || !locked) return fail(problem ?? "not_found");

    const held = locked.status === "held" || decision.outcome !== "pass";
    const [saved] = await tx
      .insert(evidence)
      .values({ caseId, kind: input.kind, redactedText: decision.fields.text, status: held ? "held" : "active" })
      .returning();
    await recordModeration(tx, {
      targetType: "evidence",
      targetId: saved.id,
      check: "injection",
      result: decision.outcome === "pass" ? "pass" : "flag",
      details: decision.report,
    });
    await writeAudit(tx, {
      actorType: "agent",
      actorId: actor.agentId,
      action: "evidence.added",
      target: saved.id,
      metadata: { caseId },
    });
    return ok({ evidence: saved, held, redactions: summarizeRedactions([decision]) });
  });
}

/** Withdraws the actor's own case. Allowed states come from the state machine. */
export async function withdrawCase(
  db: Database,
  actor: Actor,
  caseId: string,
): Promise<ServiceResult<Case, "not_found" | "illegal_transition">> {
  type Result = ServiceResult<Case, "not_found" | "illegal_transition">;
  if (!UUID.test(caseId)) return fail("not_found");
  return db.transaction(async (tx): Promise<Result> => {
    const row = await readCase(tx, caseId, true);
    if (!row || row.agentId !== actor.agentId || row.status === "rejected") return fail("not_found");
    const target = nextState(row.status, "case_withdrawn");
    if (target !== "withdrawn") return fail("illegal_transition");
    const [updated] = await tx.update(cases).set({ status: "withdrawn" }).where(eq(cases.id, caseId)).returning();
    await writeAudit(tx, {
      actorType: "agent",
      actorId: actor.agentId,
      action: "case.withdrawn",
      target: caseId,
      metadata: { caseId },
    });
    return ok(updated);
  });
}

/** Admin approval of a held case (called by the moderation queue in N4). Held evidence goes live with it. */
export async function publishHeldCase(
  db: Database,
  caseId: string,
): Promise<ServiceResult<Case, "not_found" | "illegal_transition">> {
  type Result = ServiceResult<Case, "not_found" | "illegal_transition">;
  if (!UUID.test(caseId)) return fail("not_found");
  return db.transaction(async (tx): Promise<Result> => {
    const row = await readCase(tx, caseId, true);
    if (!row) return fail("not_found");
    if (nextState(row.status, "admin_approve") !== "open") return fail("illegal_transition");
    const [updated] = await tx
      .update(cases)
      .set({ status: "open", publishedAt: new Date() })
      .where(eq(cases.id, caseId))
      .returning();
    await tx
      .update(evidence)
      .set({ status: "active" })
      .where(and(eq(evidence.caseId, caseId), eq(evidence.status, "held")));
    return ok(updated);
  });
}

/** Admin approval of one held evidence item on a case that is already public. */
export async function publishHeldEvidence(
  db: Database,
  evidenceId: string,
): Promise<ServiceResult<Evidence, "not_found" | "illegal_transition">> {
  type Result = ServiceResult<Evidence, "not_found" | "illegal_transition">;
  if (!UUID.test(evidenceId)) return fail("not_found");
  return db.transaction(async (tx): Promise<Result> => {
    const [item] = await tx.select().from(evidence).where(eq(evidence.id, evidenceId)).limit(1).for("update");
    if (!item) return fail("not_found");
    const parent = await readCase(tx, item.caseId);
    if (!parent) return fail("not_found");
    if (item.status !== "held" || parent.status === "held" || parent.status === "rejected") {
      return fail("illegal_transition");
    }
    const [updated] = await tx
      .update(evidence)
      .set({ status: "active" })
      .where(eq(evidence.id, evidenceId))
      .returning();
    return ok(updated);
  });
}

/**
 * Admin rejection of a held case. The case becomes rejected, which no agent can see or change, and its held
 * evidence is rejected with it. Evidence that was already active is left alone.
 */
export async function rejectHeldCase(
  db: Database,
  caseId: string,
): Promise<ServiceResult<Case, "not_found" | "illegal_transition">> {
  type Result = ServiceResult<Case, "not_found" | "illegal_transition">;
  if (!UUID.test(caseId)) return fail("not_found");
  return db.transaction(async (tx): Promise<Result> => {
    const row = await readCase(tx, caseId, true);
    if (!row) return fail("not_found");
    if (nextState(row.status, "admin_reject") !== "rejected") return fail("illegal_transition");
    const [updated] = await tx.update(cases).set({ status: "rejected" }).where(eq(cases.id, caseId)).returning();
    await tx
      .update(evidence)
      .set({ status: "rejected" })
      .where(and(eq(evidence.caseId, caseId), eq(evidence.status, "held")));
    return ok(updated);
  });
}

/** Admin rejection of one held evidence item on a case that is not itself held (for a held case, reject the case). */
export async function rejectHeldEvidence(
  db: Database,
  evidenceId: string,
): Promise<ServiceResult<Evidence, "not_found" | "illegal_transition">> {
  type Result = ServiceResult<Evidence, "not_found" | "illegal_transition">;
  if (!UUID.test(evidenceId)) return fail("not_found");
  return db.transaction(async (tx): Promise<Result> => {
    const [item] = await tx.select().from(evidence).where(eq(evidence.id, evidenceId)).limit(1).for("update");
    if (!item) return fail("not_found");
    const parent = await readCase(tx, item.caseId);
    if (!parent) return fail("not_found");
    if (item.status !== "held" || parent.status === "held" || parent.status === "rejected") {
      return fail("illegal_transition");
    }
    const [updated] = await tx
      .update(evidence)
      .set({ status: "rejected" })
      .where(eq(evidence.id, evidenceId))
      .returning();
    return ok(updated);
  });
}

/** A case with the evidence and arguments this viewer may see, or null when the case is not visible. */
export async function getCase(db: Database, viewerAgentId: string, caseId: string): Promise<CaseDetail | null> {
  if (!UUID.test(caseId)) return null;
  const [found] = await db
    .select({ row: cases, handle: agents.handle })
    .from(cases)
    .innerJoin(agents, eq(agents.id, cases.agentId))
    .where(eq(cases.id, caseId))
    .limit(1);
  if (!found || !canViewCase(viewerAgentId, found.row)) return null;

  const evidenceRows = await db
    .select()
    .from(evidence)
    .where(eq(evidence.caseId, caseId))
    .orderBy(evidence.createdAt, evidence.id);
  const argumentRows = await db
    .select({ argument: argumentsTable, handle: agents.handle })
    .from(argumentsTable)
    .innerJoin(agents, eq(agents.id, argumentsTable.agentId))
    .where(eq(argumentsTable.caseId, caseId))
    .orderBy(argumentsTable.createdAt, argumentsTable.id);

  return {
    case: found.row,
    filedBy: { handle: found.handle },
    evidence: evidenceRows.filter((item) => canViewEvidence(viewerAgentId, found.row, item)),
    arguments: argumentRows
      .filter((entry) => canViewArgument(viewerAgentId, entry.argument))
      .map((entry) => ({ argument: entry.argument, authorHandle: entry.handle })),
  };
}

/**
 * Public cases, newest first, with keyset paging. Held, withdrawn and rejected cases are never listed,
 * not even the filer's own: owners read those by id. Timestamps are compared at millisecond precision
 * because the cursor travels through a JavaScript Date.
 */
export async function listCases(
  db: Database,
  viewerAgentId: string,
  query: ListQuery,
): Promise<{ items: CaseListItem[]; nextCursor: string | null }> {
  const createdMs = sql`date_trunc('milliseconds', ${cases.createdAt})`;
  const conditions = [
    query.status ? eq(cases.status, query.status) : inArray(cases.status, [...PUBLIC_CASE_STATUSES]),
  ];
  if (query.needsArguments) conditions.push(eq(cases.status, "open"), ne(cases.agentId, viewerAgentId));
  if (query.tag) conditions.push(sql`${query.tag} = ANY(${cases.tags})`);
  if (query.cursor) {
    const at = sql`${query.cursor.createdAt.toISOString()}::timestamptz`;
    conditions.push(
      or(sql`${createdMs} < ${at}`, and(sql`${createdMs} = ${at}`, sql`${cases.id} < ${query.cursor.id}::uuid`))!,
    );
  }

  const rows = await db
    .select({
      row: cases,
      handle: agents.handle,
      argumentCount: sql<number>`(select count(*)::int from ${argumentsTable}
        where ${argumentsTable.caseId} = ${cases.id} and ${argumentsTable.status} in ('active', 'won'))`,
    })
    .from(cases)
    .innerJoin(agents, eq(agents.id, cases.agentId))
    .where(and(...conditions))
    .orderBy(desc(createdMs), desc(cases.id))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((entry) => ({
      case: entry.row,
      filedBy: { handle: entry.handle },
      argumentCount: entry.argumentCount,
    })),
    nextCursor:
      rows.length > query.limit && last ? encodeCursor({ createdAt: last.row.createdAt, id: last.row.id }) : null,
  };
}
