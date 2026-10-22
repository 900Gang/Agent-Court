import { z } from "zod";
import { LIMITS, TAG_PATTERN } from "@/lib/config/constants";
import type { ServiceResult } from "@/lib/services/result";
import { evidenceInputSchema } from "./evidence";
import { parseWith, requiredText } from "./fields";

// A fixed set of short fields instead of free-form JSON: less room to hide instructions or oversized data.
const environmentSchema = z
  .strictObject({
    model: requiredText(80).optional(),
    framework: requiredText(80).optional(),
    framework_version: requiredText(40).optional(),
    language: requiredText(40).optional(),
    os: requiredText(40).optional(),
    tools: z.array(requiredText(60)).max(20, "at most 20 tools").optional(),
    notes: requiredText(500).optional(),
  })
  .refine((environment) => new TextEncoder().encode(JSON.stringify(environment)).byteLength <= LIMITS.environmentBytes, {
    error: `at most ${LIMITS.environmentBytes} bytes`,
  });

// Tags are rejected, not corrected: a sentence-like tag is a sign the field is being used for instructions.
const tagsSchema = z
  .array(
    z
      .string({ error: "must be text" })
      .refine((tag) => TAG_PATTERN.test(tag), { error: "use lower-case letters, digits and hyphens, 1 to 32 characters" }),
  )
  .transform((tags, ctx) => {
    const unique = [...new Set(tags)];
    if (unique.length > LIMITS.tagsPerCase) {
      ctx.addIssue({ code: "custom", message: `at most ${LIMITS.tagsPerCase} tags` });
      return z.NEVER;
    }
    return unique;
  });

export const caseInputSchema = z.strictObject({
  title: requiredText(LIMITS.title),
  summary: requiredText(LIMITS.summary),
  expected: requiredText(LIMITS.expectedActual),
  actual: requiredText(LIMITS.expectedActual),
  environment: environmentSchema.default({}),
  tags: tagsSchema.default([]),
  evidence: z.array(evidenceInputSchema).max(LIMITS.evidencePerCase, `at most ${LIMITS.evidencePerCase} items`).default([]),
});

export type CaseInput = z.infer<typeof caseInputSchema>;
export type EnvironmentInput = z.infer<typeof environmentSchema>;

export function parseCaseInput(raw: unknown): ServiceResult<CaseInput, "invalid"> {
  return parseWith(caseInputSchema, raw);
}
