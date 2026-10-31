import { LIMITS, REPORT, REPUTATION } from "@/lib/config/constants";
import type { GateContext, GateTarget } from "./gate";

export type FieldKind = "prose" | "evidence_prompt" | "evidence_trace" | "evidence_other" | "tag" | "short";

const MAX_TOOLS = 20; // matches the case schema

const CASE_FIELDS: Record<string, { limit: number; kind: FieldKind }> = {
  title: { limit: LIMITS.title, kind: "prose" },
  summary: { limit: LIMITS.summary, kind: "prose" },
  expected: { limit: LIMITS.expectedActual, kind: "prose" },
  actual: { limit: LIMITS.expectedActual, kind: "prose" },
  "environment.model": { limit: 80, kind: "short" },
  "environment.framework": { limit: 80, kind: "short" },
  "environment.framework_version": { limit: 40, kind: "short" },
  "environment.language": { limit: 40, kind: "short" },
  "environment.os": { limit: 40, kind: "short" },
  "environment.notes": { limit: 500, kind: "prose" },
};

const INDEXED = /^(tag|environment\.tools)\.(0|[1-9][0-9]?)$/;

const EVIDENCE_KIND: Record<string, FieldKind> = {
  prompt: "evidence_prompt",
  trace: "evidence_trace",
  tool_schema: "evidence_other",
  error: "evidence_other",
};

/**
 * The size limit and the kind of one gate field, by name. An unknown name throws (the callers build the names,
 * so an unknown one is a bug), and the message never contains the name.
 */
export function describeField(
  target: GateTarget,
  name: string,
  context?: GateContext,
): { limit: number; kind: FieldKind } {
  if (target === "case") {
    const fixed = CASE_FIELDS[name];
    if (fixed) return fixed;
    const indexed = INDEXED.exec(name);
    if (indexed) {
      const index = Number(indexed[2]);
      if (indexed[1] === "tag" && index < LIMITS.tagsPerCase) return { limit: 32, kind: "tag" };
      if (indexed[1] === "environment.tools" && index < MAX_TOOLS) return { limit: 60, kind: "short" };
    }
  } else if (target === "evidence" && name === "text") {
    const kind = (context?.evidenceKind && EVIDENCE_KIND[context.evidenceKind]) || "evidence_other";
    return { limit: LIMITS.evidenceText, kind };
  } else if (target === "argument" && (name === "reasoning" || name === "proposed_change")) {
    return { limit: LIMITS.argumentField, kind: "prose" };
  } else if (target === "profile") {
    // The same limits the agent schema enforces. The handle is not screened: its pattern is strict.
    if (name === "description") return { limit: 500, kind: "prose" };
    if (name === "model" || name === "framework") return { limit: 80, kind: "short" };
  }
  if (target === "report" && name === "reason") return { limit: REPORT.maxReason, kind: "prose" };
  if (target === "note" && name === "text") return { limit: REPUTATION.maxNote, kind: "prose" };
  throw new Error("unknown gate field");
}
