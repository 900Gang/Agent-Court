import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { agents, argumentsTable, cases, evidence, moderationEvents } from "@/db/schema";
import type { Database } from "@/db/types";

const DEFAULT_LIMIT = 50;

/** What the gate found, as rule ids and redaction types with counts. No positions, no scores, no text. */
export type GateSummary = {
  version: string | null;
  outcome: string | null;
  rules: Array<{ rule: string; count: number }>;
  redactions: Array<{ type: string; count: number }>;
};

export type QueueCase = {
  id: string;
  agentHandle: string;
  createdAt: Date;
  title: string;
  summary: string;
  expected: string;
  actual: string;
  environment: Record<string, unknown>;
  tags: string[];
  /** The case's held evidence. It is approved or rejected with the case, so it is not listed again. */
  evidence: Array<{ id: string; kind: string; text: string }>;
  gate: GateSummary | null;
};

/** Held evidence on a case that is not itself held. */
export type QueueEvidence = {
  id: string;
  caseId: string;
  caseTitle: string;
  agentHandle: string;
  kind: string;
  text: string;
  createdAt: Date;
  gate: GateSummary | null;
};

export type QueueArgument = {
  id: string;
  caseId: string;
  caseTitle: string;
  agentHandle: string;
  reasoning: string;
  proposedChange: string;
  createdAt: Date;
  gate: GateSummary | null;
};

export type ModerationQueue = {
  cases: QueueCase[];
  evidence: QueueEvidence[];
  arguments: QueueArgument[];
  /** True when any list was cut at the limit. */
  truncated: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function byCountThenName<K extends "rule" | "type">(key: K) {
  return (a: Record<K, string> & { count: number }, b: Record<K, string> & { count: number }) =>
    b.count - a.count || a[key].localeCompare(b[key]);
}

/** Reads a stored gate report. Anything unexpected (an N3 stub row, an old shape) gives empty lists, never a throw. */
export function summarizeGate(details: unknown): GateSummary {
  const report = isRecord(details) ? details : {};

  const ruleCounts = new Map<string, number>();
  if (isRecord(report.fields)) {
    for (const field of Object.values(report.fields)) {
      if (!isRecord(field) || !Array.isArray(field.hits)) continue;
      for (const hit of field.hits) {
        if (isRecord(hit) && typeof hit.rule === "string" && isCount(hit.count)) {
          ruleCounts.set(hit.rule, (ruleCounts.get(hit.rule) ?? 0) + hit.count);
        }
      }
    }
  }

  const redactions: Array<{ type: string; count: number }> = [];
  if (isRecord(report.redactions) && isRecord(report.redactions.types)) {
    for (const [type, count] of Object.entries(report.redactions.types)) {
      if (isCount(count)) redactions.push({ type, count });
    }
  }

  return {
    version: typeof report.version === "string" ? report.version : null,
    outcome: typeof report.outcome === "string" ? report.outcome : null,
    rules: [...ruleCounts].map(([rule, count]) => ({ rule, count })).sort(byCountThenName("rule")),
    redactions: redactions.sort(byCountThenName("type")),
  };
}

/** The newest moderation event of each target, as a gate summary. A target with no event has no entry. */
async function latestGates(
  db: Database,
  targetType: "case" | "evidence" | "argument",
  targetIds: string[],
): Promise<Map<string, GateSummary>> {
  const found = new Map<string, GateSummary>();
  if (targetIds.length === 0) return found;
  const rows = await db
    .select({ targetId: moderationEvents.targetId, details: moderationEvents.details })
    .from(moderationEvents)
    .where(and(eq(moderationEvents.targetType, targetType), inArray(moderationEvents.targetId, targetIds)))
    .orderBy(desc(moderationEvents.createdAt), desc(moderationEvents.id));
  for (const row of rows) {
    if (row.targetId !== null && !found.has(row.targetId)) found.set(row.targetId, summarizeGate(row.details));
  }
  return found;
}

/**
 * Everything waiting for a human decision: held cases (with their held evidence), held evidence on cases that are
 * already public, and held arguments. Oldest first, at most `limit` of each kind. The output holds no operator ids
 * and no key data.
 */
export async function loadModerationQueue(
  db: Database,
  options: { limit?: number } = {},
): Promise<ModerationQueue> {
  const limit = options.limit ?? DEFAULT_LIMIT;

  const caseRows = await db
    .select({ row: cases, handle: agents.handle })
    .from(cases)
    .innerJoin(agents, eq(agents.id, cases.agentId))
    .where(eq(cases.status, "held"))
    .orderBy(asc(cases.createdAt), asc(cases.id))
    .limit(limit + 1);

  // A held case's held evidence goes with the case. Evidence on any other case (rejected ones are gone) is its own item.
  const evidenceRows = await db
    .select({ row: evidence, caseTitle: cases.title, handle: agents.handle })
    .from(evidence)
    .innerJoin(cases, eq(cases.id, evidence.caseId))
    .innerJoin(agents, eq(agents.id, cases.agentId))
    .where(and(eq(evidence.status, "held"), notInArray(cases.status, ["held", "rejected"])))
    .orderBy(asc(evidence.createdAt), asc(evidence.id))
    .limit(limit + 1);

  const argumentRows = await db
    .select({ row: argumentsTable, caseTitle: cases.title, handle: agents.handle })
    .from(argumentsTable)
    .innerJoin(cases, eq(cases.id, argumentsTable.caseId))
    .innerJoin(agents, eq(agents.id, argumentsTable.agentId))
    .where(eq(argumentsTable.status, "held"))
    .orderBy(asc(argumentsTable.createdAt), asc(argumentsTable.id))
    .limit(limit + 1);

  const truncated = caseRows.length > limit || evidenceRows.length > limit || argumentRows.length > limit;
  const shownCases = caseRows.slice(0, limit);
  const shownEvidence = evidenceRows.slice(0, limit);
  const shownArguments = argumentRows.slice(0, limit);

  const caseIds = shownCases.map((entry) => entry.row.id);
  const nested = caseIds.length
    ? await db
        .select()
        .from(evidence)
        .where(and(inArray(evidence.caseId, caseIds), eq(evidence.status, "held")))
        .orderBy(asc(evidence.createdAt), asc(evidence.id))
    : [];

  const [caseGates, evidenceGates, argumentGates] = await Promise.all([
    latestGates(db, "case", caseIds),
    latestGates(db, "evidence", shownEvidence.map((entry) => entry.row.id)),
    latestGates(db, "argument", shownArguments.map((entry) => entry.row.id)),
  ]);

  return {
    cases: shownCases.map(({ row, handle }) => ({
      id: row.id,
      agentHandle: handle,
      createdAt: row.createdAt,
      title: row.title,
      summary: row.summary,
      expected: row.expected,
      actual: row.actual,
      environment: isRecord(row.environment) ? row.environment : {},
      tags: row.tags,
      evidence: nested
        .filter((item) => item.caseId === row.id)
        .map((item) => ({ id: item.id, kind: item.kind, text: item.redactedText })),
      gate: caseGates.get(row.id) ?? null,
    })),
    evidence: shownEvidence.map(({ row, caseTitle, handle }) => ({
      id: row.id,
      caseId: row.caseId,
      caseTitle,
      agentHandle: handle,
      kind: row.kind,
      text: row.redactedText,
      createdAt: row.createdAt,
      gate: evidenceGates.get(row.id) ?? null,
    })),
    arguments: shownArguments.map(({ row, caseTitle, handle }) => ({
      id: row.id,
      caseId: row.caseId,
      caseTitle,
      agentHandle: handle,
      reasoning: row.reasoning,
      proposedChange: row.proposedChange,
      createdAt: row.createdAt,
      gate: argumentGates.get(row.id) ?? null,
    })),
    truncated,
  };
}
