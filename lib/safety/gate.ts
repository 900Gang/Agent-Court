import { logger } from "@/lib/config/logger";

export type GateTarget = "case" | "evidence" | "argument" | "profile" | "report" | "note";

export type GateInput = {
  target: GateTarget;
  /** The text fields to screen, by name. The decision returns the text to store under the same names. */
  fields: Record<string, string>;
  /** Extra facts that change how a field is weighed, such as the kind of an evidence item. */
  context?: GateContext;
};

export type GateContext = { evidenceKind?: "trace" | "prompt" | "tool_schema" | "error" };

export type GateOutcome = "pass" | "flag" | "block";

export type GateDecision = {
  outcome: GateOutcome;
  /** The text to store: redacted by the real gate (N4), unchanged by the N3 stub. */
  fields: Record<string, string>;
  /** Rule names and counts only. Never the matched text. */
  report: Record<string, unknown>;
};

export interface SafetyGate {
  screen(input: GateInput): Promise<GateDecision>;
}

const OUTCOMES: readonly string[] = ["pass", "flag", "block"];

function isDecision(value: unknown): value is GateDecision {
  if (typeof value !== "object" || value === null) return false;
  const { outcome, fields, report } = value as Record<string, unknown>;
  return (
    typeof outcome === "string" &&
    OUTCOMES.includes(outcome) &&
    typeof fields === "object" &&
    fields !== null &&
    Object.values(fields).every((entry) => typeof entry === "string") &&
    typeof report === "object" &&
    report !== null
  );
}

/**
 * Runs the gate and fails closed: a thrown error or a malformed decision becomes `flag`, never `pass`.
 * The failure is logged with its class and the target only. The error text is dropped on purpose, so a message
 * that quotes content cannot reach a report or a log.
 */
export async function screenSafely(gate: SafetyGate, input: GateInput): Promise<GateDecision> {
  try {
    const decision = await gate.screen(input);
    // The stored text comes from the returned fields, so every field that went in must come back.
    if (isDecision(decision) && Object.keys(input.fields).every((key) => key in decision.fields)) return decision;
    logger.warn("gate failure", { target: input.target, errorClass: "InvalidDecision" });
  } catch (error) {
    logger.warn("gate failure", {
      target: input.target,
      errorClass: error instanceof Error ? error.constructor.name : "NonError",
    });
  }
  return { outcome: "flag", fields: input.fields, report: { error: "gate_failure" } };
}
