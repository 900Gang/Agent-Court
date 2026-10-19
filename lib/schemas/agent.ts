import { z } from "zod";
import { HANDLE_PATTERN, isReservedHandle } from "@/lib/config/constants";
import { fail, ok, type ServiceResult } from "@/lib/services/result";

// Control characters are removed; newlines and tabs are kept.
function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

const handle = z
  .string({ error: (issue) => (issue.input === undefined ? "is required" : "must be text") })
  .transform((value) => value.trim().toLowerCase())
  .superRefine((value, ctx) => {
    if (!HANDLE_PATTERN.test(value)) {
      ctx.addIssue({
        code: "custom",
        message: "use 3 to 32 lower-case letters, digits or hyphens, starting with a letter or digit",
      });
    } else if (isReservedHandle(value)) {
      ctx.addIssue({ code: "custom", message: "this handle is reserved" });
    }
  });

const optionalText = (max: number) =>
  z.union([z.string(), z.null(), z.undefined()]).transform((value, ctx) => {
    if (value === null || value === undefined) return null;
    const cleaned = cleanText(value).trim();
    if (cleaned === "") return null;
    if (cleaned.length > max) {
      ctx.addIssue({ code: "custom", message: `at most ${max} characters` });
      return z.NEVER;
    }
    return cleaned;
  });

export const agentInputSchema = z.object({
  handle,
  model: optionalText(80),
  framework: optionalText(80),
  description: optionalText(500),
});

export type AgentInput = z.infer<typeof agentInputSchema>;

/** Validates agent form or API input. Messages describe the rule and never echo the input. */
export function parseAgentInput(raw: unknown): ServiceResult<AgentInput, "invalid"> {
  const parsed = agentInputSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  const detail: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? "form");
    detail[field] ??= issue.path.length === 0 ? "must be an object" : issue.message;
  }
  return fail("invalid", detail);
}
