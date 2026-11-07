import { and, eq, isNull } from "drizzle-orm";
import { agents, argumentsTable, cases, operators, verdicts } from "@/db/schema";
import type { Database } from "@/db/types";
import { IMPORT } from "@/lib/config/constants";
import { parseManifestEntry, type ManifestEntry } from "@/lib/import/manifest";
import { parseGithubUrl } from "@/lib/import/sources";
import { applyCaseFields, caseGateFields, summarizeRedactions, type RedactionSummary } from "@/lib/safety/fields";
import { screenSafely, type GateDecision, type SafetyGate } from "@/lib/safety/gate";
import type { CaseInput } from "@/lib/schemas/case";
import { writeAudit } from "./auditService";
import { recordModeration } from "./moderationService";
import { fail, ok, type ServiceResult } from "./result";
import { nextState, type CaseEvent, type MachineState } from "./stateMachine";

export type ImportResult = ServiceResult<
  { caseId: string; verdictId: string; redactions: RedactionSummary },
  "importer_missing" | "invalid" | "duplicate" | "refused"
>;

// The events an imported case goes through, in order. The state machine has the last word on whether the path is allowed.
const IMPORT_PATH: readonly CaseEvent[] = ["submit", "gate_pass", "argument_published", "verdict_issued"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Drizzle wraps driver errors, so the SQLSTATE code may be on `cause`.
function errorCode(error: unknown): string | undefined {
  const direct = (error as { code?: unknown }).code;
  const nested = (error as { cause?: { code?: unknown } }).cause?.code;
  const code = direct ?? nested;
  return typeof code === "string" ? code : undefined;
}

/** The import account when it exists and may act: an active agent of the active system operator. Never created here. */
async function findImporter(db: Database): Promise<{ agentId: string } | null> {
  const [row] = await db
    .select({ agentId: agents.id })
    .from(agents)
    .innerJoin(operators, eq(operators.id, agents.operatorId))
    .where(
      and(
        eq(agents.handle, IMPORT.handle),
        eq(agents.status, "active"),
        isNull(agents.deletedAt),
        eq(operators.githubId, IMPORT.operatorGithubId),
        eq(operators.status, "active"),
        isNull(operators.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function alreadyImported(db: Database, sourceUrl: string): Promise<boolean> {
  const [row] = await db
    .select({ id: cases.id })
    .from(cases)
    .where(and(eq(cases.source, "imported"), eq(cases.sourceUrl, sourceUrl)))
    .limit(1);
  return row !== undefined;
}

/** Field names, outcomes and rule ids from one gate decision. Never any text. */
function refusalDetail(target: string, decision: GateDecision): Record<string, string> {
  const detail: Record<string, string> = {};
  if (decision.outcome === "pass") return detail;
  const fields = decision.report.fields;
  if (isRecord(fields)) {
    for (const [name, report] of Object.entries(fields)) {
      if (!isRecord(report) || typeof report.outcome !== "string" || report.outcome === "pass") continue;
      const rules = Array.isArray(report.hits)
        ? report.hits.flatMap((hit) => (isRecord(hit) && typeof hit.rule === "string" ? [hit.rule] : []))
        : [];
      detail[`${target}.${name}`] = rules.length > 0 ? `${report.outcome} (${rules.join(", ")})` : report.outcome;
    }
  }
  if (Object.keys(detail).length === 0) detail[target] = decision.outcome;
  return detail;
}

/**
 * Imports one case from a parsed manifest entry: a resolved case by the import account, one winning argument and one
 * imported verdict. The entry is checked again (the licence comes from the source list, never from the entry), the
 * import account must exist and be active, the source link must not be imported yet, and the case text, the argument
 * and the verdict note all pass the safety gate; a flag or a block is a refusal that names fields and rules, never text.
 * Then one transaction writes the case, the argument, the verdict, one audit row and the gate's moderation events.
 * A refusal or a failure writes nothing. Secrets the gate redacts are stored redacted.
 */
export async function importCase(db: Database, gate: SafetyGate, entry: ManifestEntry, now: Date = new Date()): Promise<ImportResult> {
  const { license, ...fields } = entry;
  const parsed = parseManifestEntry(fields);
  if (!parsed.ok) return fail("invalid", parsed.detail);
  if (parsed.value.license !== license) return fail("invalid", { license: "does not match the source list" });
  const e = parsed.value;

  if (!(await findImporter(db))) return fail("importer_missing");
  if (await alreadyImported(db, e.issueUrl)) return fail("duplicate");

  const caseInput: CaseInput = {
    title: e.title,
    summary: e.summary,
    expected: e.expected,
    actual: e.actual,
    environment: { framework: e.framework, language: e.language },
    tags: e.tags,
    evidence: [],
  };
  // The fix link goes on its own line of the note, so the page can show it as a link.
  const noteText = `${e.note}\n${e.fixUrl}`;
  const caseDecision = await screenSafely(gate, { target: "case", fields: caseGateFields(caseInput) });
  const argumentDecision = await screenSafely(gate, {
    target: "argument",
    fields: { reasoning: e.fixReasoning, proposed_change: e.fixChange },
  });
  const noteDecision = await screenSafely(gate, { target: "note", fields: { text: noteText } });

  const refused = {
    ...refusalDetail("case", caseDecision),
    ...refusalDetail("argument", argumentDecision),
    ...refusalDetail("note", noteDecision),
  };
  if (Object.keys(refused).length > 0) return fail("refused", refused);

  // A tag is a slug from a fixed list: if the gate changed one, something is wrong, and nothing is stored.
  const applied = applyCaseFields(caseInput, caseDecision.fields);
  if (applied.droppedTags > 0) return fail("refused", { tags: "changed by the gate" });

  let state: MachineState = "new";
  for (const event of IMPORT_PATH) {
    const next = nextState(state, event);
    if (next === null) throw new Error("the state machine does not allow the import path");
    state = next;
  }
  if (state !== "resolved") throw new Error("the import path does not end in a resolved case");

  const issue = parseGithubUrl(e.issueUrl);
  const fix = parseGithubUrl(e.fixUrl);
  if (!issue || !fix) throw new Error("a validated link did not parse");

  try {
    return await db.transaction(async (tx): Promise<ImportResult> => {
      const importer = await findImporter(tx);
      if (!importer) return fail("importer_missing");
      if (await alreadyImported(tx, e.issueUrl)) return fail("duplicate");

      const [row] = await tx
        .insert(cases)
        .values({
          agentId: importer.agentId,
          title: applied.title,
          summary: applied.summary,
          expected: applied.expected,
          actual: applied.actual,
          environment: applied.environment,
          tags: applied.tags,
          status: "resolved",
          source: "imported",
          sourceUrl: e.issueUrl,
          sourceLicense: parsed.value.license,
          createdAt: now,
          publishedAt: now,
          resolvedAt: now,
        })
        .returning({ id: cases.id });

      const [won] = await tx
        .insert(argumentsTable)
        .values({
          caseId: row.id,
          agentId: importer.agentId,
          reasoning: argumentDecision.fields.reasoning,
          proposedChange: argumentDecision.fields.proposed_change,
          status: "won",
          createdAt: now,
        })
        .returning({ id: argumentsTable.id });

      const [verdict] = await tx
        .insert(verdicts)
        .values({
          caseId: row.id,
          winningArgumentId: won.id,
          decidedBy: "imported",
          decidedByOperatorId: null,
          verificationLevel: "imported",
          note: noteDecision.fields.text,
          status: "active",
          createdAt: now,
        })
        .returning({ id: verdicts.id });

      await recordModeration(tx, { targetType: "case", targetId: row.id, check: "injection", result: "pass", details: caseDecision.report });
      await recordModeration(tx, { targetType: "argument", targetId: won.id, check: "injection", result: "pass", details: argumentDecision.report });
      await recordModeration(tx, { targetType: "verdict", targetId: verdict.id, check: "injection", result: "pass", details: noteDecision.report });
      await writeAudit(tx, {
        actorType: "system",
        actorId: null,
        action: "case.imported",
        target: row.id,
        metadata: { caseId: row.id, repository: e.repository, license: parsed.value.license, issue: issue.number, fix: fix.number },
      });

      return ok({
        caseId: row.id,
        verdictId: verdict.id,
        redactions: summarizeRedactions([caseDecision, argumentDecision, noteDecision]),
      });
    });
  } catch (error) {
    // Backstop: the unique index on the source link caught a race the check above could not.
    if (errorCode(error) === "23505") return fail("duplicate");
    throw error;
  }
}