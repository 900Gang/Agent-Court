import { LIFECYCLE } from "@/lib/config/constants";
import { normalizeText } from "@/lib/safety/normalize";
import { fail, ok, type ServiceResult } from "@/lib/services/result";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AppealInput = { caseId: string; reason: string };

const REASON_RULE = "must be text of " + LIFECYCLE.minAppeal + " to " + LIFECYCLE.maxAppeal + " characters";

/**
 * The fields of the appeal form. Anything else in the input is ignored. The reason is cleaned the way the safety gate
 * cleans text (hidden and control characters out, trimmed) and measured after that. Every message names the field and
 * states the rule, and never quotes the input.
 */
export function parseAppealInput(raw: unknown): ServiceResult<AppealInput, "invalid"> {
  const input = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const { caseId, reason } = input;
  const detail: Record<string, string> = {};

  if (typeof caseId !== "string" || !UUID.test(caseId)) detail.caseId = "must be a case id";

  let cleaned = "";
  if (typeof reason !== "string") {
    detail.reason = REASON_RULE;
  } else {
    cleaned = normalizeText(reason).text.trim();
    if (cleaned.length < LIFECYCLE.minAppeal || cleaned.length > LIFECYCLE.maxAppeal) detail.reason = REASON_RULE;
  }

  if (Object.keys(detail).length > 0) return fail("invalid", detail);
  return ok({ caseId: caseId as string, reason: cleaned });
}
