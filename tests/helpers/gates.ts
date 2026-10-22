import type { GateDecision, GateInput, SafetyGate } from "@/lib/safety/gate";

// Test-only gates. Nothing under app/, lib/ or components/ may import this file (tests/unit/gate.test.ts checks).

const decide = (outcome: GateDecision["outcome"], input: GateInput): GateDecision => ({
  outcome,
  fields: { ...input.fields },
  report: { test: outcome },
});

/** Lets everything through unchanged. */
export const passGate: SafetyGate = { screen: async (input) => decide("pass", input) };

/** Rejects everything. */
export const blockGate: SafetyGate = { screen: async (input) => decide("block", input) };

/** Flags everything, like the production stub but without the stub marker. */
export const flagGate: SafetyGate = { screen: async (input) => decide("flag", input) };

/** Throws, with a message that looks like a secret so tests can prove it never reaches a report. */
export const throwingGate: SafetyGate = {
  screen: async () => {
    throw new Error("gate exploded sk-live-secret-value-12345");
  },
};

/** Returns an outcome the interface does not allow. */
export const brokenGate: SafetyGate = {
  screen: async (input) => ({ ...decide("pass", input), outcome: "yes" as never }),
};
