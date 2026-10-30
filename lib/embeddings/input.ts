import { createHash } from "node:crypto";
import { normalizeText } from "@/lib/safety/normalize";
import { redactText } from "@/lib/safety/redact";

/** The case fields that are embedded. Evidence and arguments are not: they are long and the biggest secret surface. */
export type EmbeddingSource = {
  title: string;
  summary: string;
  expected: string;
  actual: string;
  environment: unknown;
  tags: string[];
};

const ENVIRONMENT_FACTS = [
  ["model", "Model"],
  ["framework", "Framework"],
  ["language", "Language"],
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One labelled line per field. Only three environment facts, and only when they are text. */
export function buildEmbeddingInput(source: EmbeddingSource): string {
  const lines = [`Title: ${source.title}`, `Summary: ${source.summary}`, `Expected: ${source.expected}`, `Actual: ${source.actual}`];
  const environment = isRecord(source.environment) ? source.environment : {};
  for (const [key, label] of ENVIRONMENT_FACTS) {
    const value = environment[key];
    if (typeof value === "string" && value !== "") lines.push(`${label}: ${value}`);
  }
  if (source.tags.length > 0) lines.push(`Tags: ${source.tags.join(", ")}`);
  return lines.join("\n");
}

/**
 * SHA-256 over the model and the input. The model's length goes first, so text cannot be moved between the two to
 * make a different pair give the same digest.
 */
export function hashEmbeddingInput(model: string, input: string): string {
  return createHash("sha256").update(`${model.length}:${model}\n${input}`).digest("hex");
}

/**
 * The second redaction pass. The stored text was cleaned by the gate, so nothing should change here. If anything
 * does (a secret that got through, or a hidden character left in), the case must not be sent. The answer names the
 * rules, never the text.
 */
export function checkInput(input: string): { ok: true } | { ok: false; rules: string[] } {
  const rules = new Set<string>();
  const normalized = normalizeText(input);
  if (normalized.text !== input) rules.add("hidden_characters");
  for (const item of redactText(normalized.text).items) rules.add(item.type);
  return rules.size === 0 ? { ok: true } : { ok: false, rules: [...rules].sort() };
}
