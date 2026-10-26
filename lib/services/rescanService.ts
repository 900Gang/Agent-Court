import { and, asc, count, eq, inArray, notInArray, sql, type AnyColumn } from "drizzle-orm";
import { argumentsTable, cases, evidence, moderationEvents } from "@/db/schema";
import type { Database } from "@/db/types";
import { PUBLIC_CASE_STATUSES } from "@/lib/config/constants";
import { applyCaseFields, caseGateFields } from "@/lib/safety/fields";
import { screenSafely, type GateDecision, type SafetyGate } from "@/lib/safety/gate";
import { GATE_VERSION } from "@/lib/safety/version";
import type { CaseInput } from "@/lib/schemas/case";
import { recordModeration } from "./moderationService";

/** `examined` is the sum of `redacted`, `rejected`, `unchanged` and `failed`. Counts only, never any text. */
export type RescanSummary = {
  examined: number;
  /** Items whose stored text changed. */
  redacted: number;
  /** Items that now score block. */
  rejected: number;
  unchanged: number;
  /** Items the gate could not screen. They stay held and unchanged, and the next run tries them again. */
  failed: number;
  /** Public cases whose newest moderation event is not from the current gate version. Counted, never changed. */
  publishedStale: number;
};

export type RescanOptions = {
  /** At most this many items per call. */
  limit: number;
  /** False reads and counts only. True writes. */
  apply: boolean;
  /** Items to skip, for walking a queue that does not shrink (a dry run, or items that failed). */
  offset?: number;
};

type Kind = "case" | "evidence" | "argument";
type Outcome = "redacted" | "rejected" | "unchanged" | "failed";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON with object keys in a fixed order, so two equal values compare equal whatever order a database returned. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) =>
    isRecord(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner,
  );

const gateFailed = (decision: GateDecision) => decision.report.error === "gate_failure";

/** True when the newest moderation event of this target is not from the current gate version, or there is none. */
function notScreenedByCurrentRules(kind: Kind, target: AnyColumn) {
  return sql`not exists (
    select 1 from (
      select ${moderationEvents.details} as details
      from ${moderationEvents}
      where ${moderationEvents.targetType} = ${kind}::target_type and ${moderationEvents.targetId} = ${target}
      order by ${moderationEvents.createdAt} desc, ${moderationEvents.id} desc
      limit 1
    ) latest
    where latest.details ->> 'version' = ${GATE_VERSION}
  )`;
}

async function record(db: Database, kind: Kind, id: string, decision: GateDecision): Promise<void> {
  await recordModeration(db, { targetType: kind, targetId: id, check: "injection", result: decision.outcome, details: decision.report });
}

async function rescanCase(db: Database, gate: SafetyGate, id: string, apply: boolean): Promise<Outcome | null> {
  const [row] = await db.select().from(cases).where(eq(cases.id, id)).limit(1);
  if (!row || row.status !== "held") return null;
  const held = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.caseId, id), eq(evidence.status, "held")))
    .orderBy(asc(evidence.createdAt), asc(evidence.id));

  const input: CaseInput = {
    title: row.title,
    summary: row.summary,
    expected: row.expected,
    actual: row.actual,
    environment: (isRecord(row.environment) ? row.environment : {}) as CaseInput["environment"],
    tags: row.tags,
    evidence: [],
  };
  const caseDecision = await screenSafely(gate, { target: "case", fields: caseGateFields(input) });
  const evidenceDecisions: GateDecision[] = [];
  for (const item of held) {
    evidenceDecisions.push(
      await screenSafely(gate, { target: "evidence", fields: { text: item.redactedText }, context: { evidenceKind: item.kind } }),
    );
  }
  if ([caseDecision, ...evidenceDecisions].some(gateFailed)) return "failed";

  const applied = applyCaseFields(input, caseDecision.fields);
  const texts = evidenceDecisions.map((decision) => decision.fields.text);
  const rejectedCase = caseDecision.outcome === "block";
  const caseChanged =
    canonical([row.title, row.summary, row.expected, row.actual, row.environment, row.tags]) !==
    canonical([applied.title, applied.summary, applied.expected, applied.actual, applied.environment, applied.tags]);
  const evidenceChanged = held.some((item, index) => texts[index] !== item.redactedText);
  const outcome: Outcome = rejectedCase ? "rejected" : caseChanged || evidenceChanged ? "redacted" : "unchanged";
  if (!apply) return outcome;

  return db.transaction(async (tx): Promise<Outcome | null> => {
    const [locked] = await tx.select().from(cases).where(eq(cases.id, id)).limit(1).for("update");
    if (!locked || locked.status !== "held") return null;

    if (caseChanged || rejectedCase) {
      await tx
        .update(cases)
        .set({
          title: applied.title,
          summary: applied.summary,
          expected: applied.expected,
          actual: applied.actual,
          environment: applied.environment,
          tags: applied.tags,
          ...(rejectedCase ? { status: "rejected" as const } : {}),
        })
        .where(eq(cases.id, id));
    }
    for (const [index, item] of held.entries()) {
      const reject = rejectedCase || evidenceDecisions[index].outcome === "block";
      await tx
        .update(evidence)
        .set({ redactedText: texts[index], ...(reject ? { status: "rejected" as const } : {}) })
        .where(and(eq(evidence.id, item.id), eq(evidence.status, "held")));
      await record(tx, "evidence", item.id, evidenceDecisions[index]);
    }
    await record(tx, "case", id, caseDecision);
    return outcome;
  });
}

async function rescanEvidence(db: Database, gate: SafetyGate, id: string, apply: boolean): Promise<Outcome | null> {
  const [item] = await db.select().from(evidence).where(eq(evidence.id, id)).limit(1);
  if (!item || item.status !== "held") return null;
  const decision = await screenSafely(gate, {
    target: "evidence",
    fields: { text: item.redactedText },
    context: { evidenceKind: item.kind },
  });
  if (gateFailed(decision)) return "failed";

  const text = decision.fields.text;
  const rejected = decision.outcome === "block";
  const outcome: Outcome = rejected ? "rejected" : text !== item.redactedText ? "redacted" : "unchanged";
  if (!apply) return outcome;

  return db.transaction(async (tx): Promise<Outcome | null> => {
    const [locked] = await tx.select().from(evidence).where(eq(evidence.id, id)).limit(1).for("update");
    if (!locked || locked.status !== "held") return null;
    await tx
      .update(evidence)
      .set({ redactedText: text, ...(rejected ? { status: "rejected" as const } : {}) })
      .where(eq(evidence.id, id));
    await record(tx, "evidence", id, decision);
    return outcome;
  });
}

async function rescanArgument(db: Database, gate: SafetyGate, id: string, apply: boolean): Promise<Outcome | null> {
  const [row] = await db.select().from(argumentsTable).where(eq(argumentsTable.id, id)).limit(1);
  if (!row || row.status !== "held") return null;
  const decision = await screenSafely(gate, {
    target: "argument",
    fields: { reasoning: row.reasoning, proposed_change: row.proposedChange },
  });
  if (gateFailed(decision)) return "failed";

  const { reasoning, proposed_change: proposedChange } = decision.fields;
  const rejected = decision.outcome === "block";
  const changed = reasoning !== row.reasoning || proposedChange !== row.proposedChange;
  const outcome: Outcome = rejected ? "rejected" : changed ? "redacted" : "unchanged";
  if (!apply) return outcome;

  return db.transaction(async (tx): Promise<Outcome | null> => {
    const [locked] = await tx.select().from(argumentsTable).where(eq(argumentsTable.id, id)).limit(1).for("update");
    if (!locked || locked.status !== "held") return null;
    await tx
      .update(argumentsTable)
      .set({ reasoning, proposedChange, ...(rejected ? { status: "rejected" as const } : {}) })
      .where(eq(argumentsTable.id, id));
    await record(tx, "argument", id, decision);
    return outcome;
  });
}

/**
 * Screens held content again with the current gate: cases (with their held evidence), held evidence on public
 * cases, and held arguments, skipping anything whose newest moderation event is already from this gate version.
 * With `apply`, text is replaced by the redacted text, items that now block are rejected, and one event with the
 * decision report is written for each. It never publishes anything: an item that now passes stays held.
 * Public cases are never touched, only counted when they were screened by older rules.
 */
export async function rescanHeld(db: Database, gate: SafetyGate, options: RescanOptions): Promise<RescanSummary> {
  const summary: RescanSummary = { examined: 0, redacted: 0, rejected: 0, unchanged: 0, failed: 0, publishedStale: 0 };

  const staleCases = await db
    .select({ id: cases.id })
    .from(cases)
    .where(and(eq(cases.status, "held"), notScreenedByCurrentRules("case", cases.id)))
    .orderBy(asc(cases.createdAt), asc(cases.id));
  const staleEvidence = await db
    .select({ id: evidence.id })
    .from(evidence)
    .innerJoin(cases, eq(cases.id, evidence.caseId))
    .where(
      and(
        eq(evidence.status, "held"),
        notInArray(cases.status, ["held", "rejected"]),
        notScreenedByCurrentRules("evidence", evidence.id),
      ),
    )
    .orderBy(asc(evidence.createdAt), asc(evidence.id));
  const staleArguments = await db
    .select({ id: argumentsTable.id })
    .from(argumentsTable)
    .where(and(eq(argumentsTable.status, "held"), notScreenedByCurrentRules("argument", argumentsTable.id)))
    .orderBy(asc(argumentsTable.createdAt), asc(argumentsTable.id));

  const queue: Array<{ kind: Kind; id: string }> = [
    ...staleCases.map((row) => ({ kind: "case" as const, id: row.id })),
    ...staleEvidence.map((row) => ({ kind: "evidence" as const, id: row.id })),
    ...staleArguments.map((row) => ({ kind: "argument" as const, id: row.id })),
  ];
  const offset = options.offset ?? 0;

  for (const target of queue.slice(offset, offset + options.limit)) {
    const outcome =
      target.kind === "case"
        ? await rescanCase(db, gate, target.id, options.apply)
        : target.kind === "evidence"
          ? await rescanEvidence(db, gate, target.id, options.apply)
          : await rescanArgument(db, gate, target.id, options.apply);
    if (outcome === null) continue; // decided by someone else in the meantime
    summary.examined++;
    summary[outcome]++;
  }

  const [stale] = await db
    .select({ n: count() })
    .from(cases)
    .where(and(inArray(cases.status, [...PUBLIC_CASE_STATUSES]), notScreenedByCurrentRules("case", cases.id)));
  summary.publishedStale = stale.n;
  return summary;
}
