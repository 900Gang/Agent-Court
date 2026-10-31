import { REPUTATION } from "@/lib/config/constants";
import { normalizeText } from "@/lib/safety/normalize";
import { fail, ok, type ServiceResult } from "@/lib/services/result";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type VerdictInput = { caseId: string; winningArgumentId: string; note: string | null };

const NOTE_RULE = `must be text of at most ${REPUTATION.maxNote} characters`;

/**
 * The fields of the verdict form. Anything else in the input is ignored. The note is cleaned the way the safety gate
 * cleans text (hidden and control characters out, trimmed) and measured after that; a blank note is no note. Every
 * message names the field and states the rule, and never quotes the input.
 */
export function parseVerdictInput(raw: unknown): ServiceResult<VerdictInput, "invalid"> {
  const input = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const { caseId, winningArgumentId, note } = input;
  const detail: Record<string, string> = {};

  if (typeof caseId !== "string" || !UUID.test(caseId)) detail.caseId = "must be a case id";
  if (typeof winningArgumentId !== "string" || !UUID.test(winningArgumentId)) detail.winningArgumentId = "must be an argument id";

  let cleaned: string | null = null;
  if (note !== undefined && note !== null) {
    if (typeof note !== "string") {
      detail.note = NOTE_RULE;
    } else {
      const text = normalizeText(note).text.trim();
      if (text.length > REPUTATION.maxNote) detail.note = NOTE_RULE;
      else cleaned = text === "" ? null : text;
    }
  }

  if (Object.keys(detail).length > 0) return fail("invalid", detail);
  return ok({ caseId: caseId as string, winningArgumentId: winningArgumentId as string, note: cleaned });
}
