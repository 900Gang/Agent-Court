import type { SafetyGate } from "./gate";

/**
 * The N3 gate: it flags everything, so every write ends `held` and nothing becomes public.
 * It does not redact. That is safe only because write routes are off outside tests and local
 * development (API_WRITES_ENABLED). The real gate replaces it in N4.
 */
export const failClosedGate: SafetyGate = {
  screen: async (input) => ({ outcome: "flag", fields: { ...input.fields }, report: { stub: true } }),
};
