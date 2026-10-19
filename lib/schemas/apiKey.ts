import { z } from "zod";
import { API_SCOPES, DEFAULT_KEY_EXPIRY_DAYS, type ApiScope } from "@/lib/config/constants";
import { fail, ok, type ServiceResult } from "@/lib/services/result";
import { cleanText } from "./text";

const SCOPE_MESSAGE = `choose at least one scope from: ${API_SCOPES.join(", ")}`;
const EXPIRY_MESSAGE = "choose 30 days, 90 days, 1 year or never";

const scopes = z
  .array(z.enum(API_SCOPES, { error: SCOPE_MESSAGE }), { error: SCOPE_MESSAGE })
  .min(1, { error: SCOPE_MESSAGE })
  // Remove duplicates and put the scopes in the standard order.
  .transform((chosen): ApiScope[] => API_SCOPES.filter((scope) => chosen.includes(scope)));

const expiresInDays = z.union(
  [z.literal(30), z.literal(90), z.literal(365), z.null()],
  { error: EXPIRY_MESSAGE },
);

const label = z.union([z.string(), z.null()], { error: "must be text" }).transform((value, ctx) => {
  if (value === null) return null;
  const cleaned = cleanText(value).trim();
  if (cleaned === "") return null;
  if (cleaned.length > 60) {
    ctx.addIssue({ code: "custom", message: "at most 60 characters" });
    return z.NEVER;
  }
  return cleaned;
});

const issueKeyFields = z.object({ scopes, expiresInDays, label });

// Fill in defaults first: an absent field, or one explicitly set to undefined, gets the
// default expiry (90 days) or no label.
export const issueKeyInputSchema = z.preprocess((raw) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const input: Record<string, unknown> = { ...raw };
  if (input.expiresInDays === undefined) input.expiresInDays = DEFAULT_KEY_EXPIRY_DAYS;
  if (input.label === undefined) input.label = null;
  return input;
}, issueKeyFields);

export type IssueKeyInput = z.infer<typeof issueKeyInputSchema>;

/** Validates key-issuing input. Messages describe the rule and never echo the input. */
export function parseIssueKeyInput(raw: unknown): ServiceResult<IssueKeyInput, "invalid"> {
  const parsed = issueKeyInputSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  const detail: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? "form");
    detail[field] ??= issue.path.length === 0 ? "must be an object" : issue.message;
  }
  return fail("invalid", detail);
}
