import { z } from "zod";
import { evidenceKind } from "@/db/schema";
import { LIMITS } from "@/lib/config/constants";
import type { ServiceResult } from "@/lib/services/result";
import { parseWith, requiredText } from "./fields";

export const evidenceInputSchema = z.strictObject({
  kind: z.enum(evidenceKind.enumValues, { error: `must be one of ${evidenceKind.enumValues.join(", ")}` }),
  text: requiredText(LIMITS.evidenceText),
});

export type EvidenceInput = z.infer<typeof evidenceInputSchema>;

export function parseEvidenceInput(raw: unknown): ServiceResult<EvidenceInput, "invalid"> {
  return parseWith(evidenceInputSchema, raw);
}
