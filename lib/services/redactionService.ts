import { eq } from "drizzle-orm";
import { argumentsTable, cases, evidence, operators, type Operator } from "@/db/schema";
import type { Database } from "@/db/types";
import { isActiveAdmin } from "@/lib/auth/isActiveAdmin";
import { LIMITS } from "@/lib/config/constants";
import { writeAudit } from "./auditService";
import { recordModeration } from "./moderationService";
import { fail, ok, type ServiceResult } from "./result";

/**
 * The one text an administrator's redaction can leave behind. The service never stores anything an admin typed in place of
 * what was removed, so a redaction cannot introduce new content (threat T9) and needs no pass through the safety gate.
 */
export const REDACTION_PLACEHOLDER = "[REDACTED:admin]";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIELDS = {
  case: ["title", "summary", "expected", "actual"],
  evidence: ["text"],
  argument: ["reasoning", "proposedChange"],
} as const;
type Kind = keyof typeof FIELDS;

export type RedactionResult = ServiceResult<
  { caseId: string; removed: number },
  "invalid" | "forbidden" | "not_found" | "nothing_to_redact"
>;

async function isLiveAdmin(db: Database, operatorId: string): Promise<boolean> {
  const [row] = await db.select({ role: operators.role, status: operators.status, deletedAt: operators.deletedAt }).from(operators).where(eq(operators.id, operatorId)).limit(1);
  return row !== undefined && row.role === "admin" && row.status === "active" && row.deletedAt === null;
}

/** The new text and how many characters left, or null when there is nothing to take out. */
function replace(current: string, fragment: string | null): { text: string; removed: number } | null {
  if (fragment === null) return current === REDACTION_PLACEHOLDER ? null : { text: REDACTION_PLACEHOLDER, removed: current.length };
  if (fragment === REDACTION_PLACEHOLDER || !current.includes(fragment)) return null;
  const parts = current.split(fragment);
  return { text: parts.join(REDACTION_PLACEHOLDER), removed: (parts.length - 1) * fragment.length };
}

/**
 * An administrator removes text from an argument, an evidence item or a case field: an exact fragment (every occurrence),
 * or the whole field when `fragment` is null. Order: the admin is active and an admin (the object and the database both
 * say so), the input is valid, then one transaction: the row is locked, the text is replaced by the fixed placeholder, an
 * argument is marked redacted, and one audit row and one moderation event record who, which kind and field, and how many
 * characters left, never the text. Statuses, verdicts and everything else stay as they were. Every refusal writes nothing.
 */
export async function applyRedaction(db: Database, admin: Operator, raw: unknown, now: Date = new Date()): Promise<RedactionResult> {
  if (!isActiveAdmin(admin) || !(await isLiveAdmin(db, admin.id))) return fail("forbidden");

  const input = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const { targetType, targetId, field, fragment } = input;
  const detail: Record<string, string> = {};
  const kind = typeof targetType === "string" && Object.hasOwn(FIELDS, targetType) ? (targetType as Kind) : null;
  if (kind === null) detail.targetType = "must be case, evidence or argument";
  if (typeof targetId !== "string" || !UUID.test(targetId)) detail.targetId = "must be an id";
  if (kind === null || typeof field !== "string" || !(FIELDS[kind] as readonly string[]).includes(field)) detail.field = "must be a field of that kind";
  if (fragment !== null && (typeof fragment !== "string" || fragment === "" || fragment.length > LIMITS.evidenceText)) {
    detail.fragment = "must be text to remove, or null to blank the whole field";
  }
  if (Object.keys(detail).length > 0 || kind === null) return fail("invalid", detail);
  const id = targetId as string;
  const name = field as string;
  const piece = fragment as string | null;

  return db.transaction(async (tx): Promise<RedactionResult> => {
    let caseId: string;
    let removed: number;

    if (kind === "case") {
      const [row] = await tx.select().from(cases).where(eq(cases.id, id)).limit(1).for("update");
      if (!row) return fail("not_found");
      const next = replace(row[name as "title" | "summary" | "expected" | "actual"], piece);
      if (next === null) return fail("nothing_to_redact");
      await tx.update(cases).set({ [name]: next.text } as { title?: string; summary?: string; expected?: string; actual?: string }).where(eq(cases.id, id));
      caseId = row.id;
      removed = next.removed;
    } else if (kind === "evidence") {
      const [row] = await tx.select().from(evidence).where(eq(evidence.id, id)).limit(1).for("update");
      if (!row) return fail("not_found");
      const next = replace(row.redactedText, piece);
      if (next === null) return fail("nothing_to_redact");
      await tx.update(evidence).set({ redactedText: next.text }).where(eq(evidence.id, id));
      caseId = row.caseId;
      removed = next.removed;
    } else {
      const [row] = await tx.select().from(argumentsTable).where(eq(argumentsTable.id, id)).limit(1).for("update");
      if (!row) return fail("not_found");
      const next = replace(row[name as "reasoning" | "proposedChange"], piece);
      if (next === null) return fail("nothing_to_redact");
      await tx.update(argumentsTable).set({ [name]: next.text, redactedAt: now } as { reasoning?: string; proposedChange?: string; redactedAt: Date }).where(eq(argumentsTable.id, id));
      caseId = row.caseId;
      removed = next.removed;
    }

    await writeAudit(tx, { actorType: "operator", actorId: admin.id, action: "redaction.applied", target: id, metadata: { targetType: kind, field: name, removed } });
    await recordModeration(tx, { targetType: kind, targetId: id, check: "manual", result: "pass", details: { action: "redact", field: name, removed } });
    return ok({ caseId, removed });
  });
}
