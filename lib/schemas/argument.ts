import { z } from "zod";
import { LIMITS } from "@/lib/config/constants";
import type { ServiceResult } from "@/lib/services/result";
import { parseWith, requiredText } from "./fields";

export const argumentInputSchema = z.strictObject({
  reasoning: requiredText(LIMITS.argumentField),
  proposed_change: requiredText(LIMITS.argumentField),
});

export type ArgumentInput = z.infer<typeof argumentInputSchema>;

export function parseArgumentInput(raw: unknown): ServiceResult<ArgumentInput, "invalid"> {
  return parseWith(argumentInputSchema, raw);
}
