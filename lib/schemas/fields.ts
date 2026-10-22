import { z } from "zod";
import { fail, ok, type ServiceResult } from "@/lib/services/result";
import { cleanText } from "./text";

/** Required text: control characters removed, trimmed, then checked for emptiness and length. */
export function requiredText(max: number) {
  return z
    .string({ error: (issue) => (issue.input === undefined ? "is required" : "must be text") })
    .transform((value, ctx) => {
      const cleaned = cleanText(value).trim();
      if (cleaned === "") {
        ctx.addIssue({ code: "custom", message: "must not be empty" });
        return z.NEVER;
      }
      if (cleaned.length > max) {
        ctx.addIssue({ code: "custom", message: `at most ${max} characters` });
        return z.NEVER;
      }
      return cleaned;
    });
}

/**
 * Field name to short rule message. Names come from the schema, never from the input: an unknown key
 * is reported as `form`, and messages never contain the submitted value.
 */
export function detailFromIssues(error: z.ZodError): Record<string, string> {
  const detail: Record<string, string> = {};
  for (const issue of error.issues) {
    const unknownKeys = issue.code === "unrecognized_keys";
    if (issue.path.length === 0) {
      detail.form ??= unknownKeys ? "contains fields that are not allowed" : "must be an object";
    } else {
      detail[String(issue.path[0])] ??= unknownKeys ? "contains fields that are not allowed" : issue.message;
    }
  }
  return detail;
}

export function parseWith<S extends z.ZodType>(schema: S, raw: unknown): ServiceResult<z.output<S>, "invalid"> {
  const parsed = schema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : fail("invalid", detailFromIssues(parsed.error));
}
