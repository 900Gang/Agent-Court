import type { CaseInput, EnvironmentInput } from "@/lib/schemas/case";
import type { GateDecision } from "./gate";

/** How many secrets and personal details the gate removed, and of which kinds. Counts only, never text. */
export type RedactionSummary = { total: number; types: Record<string, number> };

const ENVIRONMENT_TEXT = ["model", "framework", "framework_version", "language", "os", "notes"] as const;

/**
 * Every agent-written text of a case, under the names `describeField` knows: the four prose fields, each
 * environment value, each tool name and each tag. Evidence is screened separately, with its kind.
 */
export function caseGateFields(input: CaseInput): Record<string, string> {
  const fields: Record<string, string> = {
    title: input.title,
    summary: input.summary,
    expected: input.expected,
    actual: input.actual,
  };
  for (const key of ENVIRONMENT_TEXT) {
    const value = input.environment[key];
    if (value !== undefined) fields[`environment.${key}`] = value;
  }
  input.environment.tools?.forEach((tool, index) => {
    fields[`environment.tools.${index}`] = tool;
  });
  input.tags.forEach((tag, index) => {
    fields[`tag.${index}`] = tag;
  });
  return fields;
}

/**
 * Rebuilds the case from the text the gate returned. A tag whose returned text differs from the submitted one
 * is dropped and counted (a tag is a slug: if redaction touched it, it was never a tag), and duplicates are removed.
 */
export function applyCaseFields(
  input: CaseInput,
  fields: Record<string, string>,
): {
  title: string;
  summary: string;
  expected: string;
  actual: string;
  environment: EnvironmentInput;
  tags: string[];
  droppedTags: number;
} {
  // screenSafely guarantees every field comes back; a missing one is a bug, and storing the original would skip redaction.
  const returned = (name: string): string => {
    const value = fields[name];
    if (value === undefined) throw new Error("gate returned no text for a field");
    return value;
  };

  const environment: EnvironmentInput = {};
  for (const key of ENVIRONMENT_TEXT) {
    if (input.environment[key] !== undefined) environment[key] = returned(`environment.${key}`);
  }
  if (input.environment.tools !== undefined) {
    environment.tools = input.environment.tools.map((_, index) => returned(`environment.tools.${index}`));
  }

  const tags: string[] = [];
  let droppedTags = 0;
  input.tags.forEach((tag, index) => {
    if (returned(`tag.${index}`) !== tag) droppedTags++;
    else if (!tags.includes(tag)) tags.push(tag);
  });

  return {
    title: returned("title"),
    summary: returned("summary"),
    expected: returned("expected"),
    actual: returned("actual"),
    environment,
    tags,
    droppedTags,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Adds up the redactions the gate reported over several decisions. A decision without a usable report counts as zero. */
export function summarizeRedactions(decisions: GateDecision[]): RedactionSummary {
  const summary: RedactionSummary = { total: 0, types: {} };
  for (const decision of decisions) {
    const redactions = decision.report.redactions;
    if (!isRecord(redactions) || typeof redactions.total !== "number" || !Number.isFinite(redactions.total)) continue;
    summary.total += redactions.total;
    if (!isRecord(redactions.types)) continue;
    for (const [type, count] of Object.entries(redactions.types)) {
      if (typeof count === "number" && Number.isFinite(count)) summary.types[type] = (summary.types[type] ?? 0) + count;
    }
  }
  return summary;
}
