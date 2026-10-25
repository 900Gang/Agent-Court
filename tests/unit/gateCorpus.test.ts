import { describe, expect, it } from "vitest";
import { createGate } from "@/lib/safety/engine";
import type { GateContext, GateDecision, GateTarget } from "@/lib/safety/gate";
import { normalizeText } from "@/lib/safety/normalize";
import { loadClean, loadInjections, loadSecrets, type CorpusSet } from "../helpers/corpus";

// Acceptance test for the whole gate (AC-403, AC-405, AC-407). Rules are tuned on the dev set only. For the
// holdout set a failure is reported as counts and categories, never as entries, so the set stays a fair test.
// The corpora were written by the same person as the rules, so tests/unit/gateRegression.test.ts holds strings
// that were not in them.

const gate = createGate();

type Shape = { target: GateTarget; name: string; context?: GateContext };
const SHAPES: Record<string, Shape> = {
  prose: { target: "case", name: "summary" },
  evidence_prompt: { target: "evidence", name: "text", context: { evidenceKind: "prompt" } },
  evidence_trace: { target: "evidence", name: "text", context: { evidenceKind: "trace" } },
  evidence_other: { target: "evidence", name: "text", context: { evidenceKind: "error" } },
};

async function run(text: string, shape: Shape): Promise<{ decision: GateDecision; output: string }> {
  const decision = await gate.screen({ target: shape.target, fields: { [shape.name]: text }, context: shape.context });
  return { decision, output: decision.fields[shape.name] };
}

function tally(labels: string[]): string {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].map(([label, n]) => `${label}:${n}`).join(", ");
}

function report(set: CorpusSet, failures: string[], labels: string[]): string {
  return set === "dev" ? `failing ids: ${failures.join(", ")}` : `${failures.length} failed; categories: ${tally(labels)}`;
}

describe.each(["dev", "holdout"] as const)("gate acceptance, %s set", (set) => {
  it("redacts at least 98% of planted secrets, with an accepted placeholder, and keeps what must stay", async () => {
    const entries = loadSecrets().filter((e) => e.set === set);
    const failures: string[] = [];
    const labels: string[] = [];
    for (const entry of entries) {
      const secret = normalizeText(entry.secret).text;
      const { decision, output } = await run(entry.text, SHAPES.prose);
      const placeholders = [...output.matchAll(/\[REDACTED:([a-z_]+)\]/g)].map((m) => m[1]);
      const ok =
        !output.includes(secret) &&
        !JSON.stringify(decision.report).includes(secret) &&
        placeholders.some((type) => entry.accepts.includes(type)) &&
        entry.keep.every((keep) => output.includes(keep));
      if (!ok) {
        failures.push(entry.id);
        labels.push(entry.type);
      }
    }
    console.info(`gate corpus ${set}: secrets redacted ${entries.length - failures.length}/${entries.length}`);
    expect((entries.length - failures.length) / entries.length, report(set, failures, labels)).toBeGreaterThanOrEqual(0.98);
  });

  it("flags or blocks every injection, and blocks the ones that must be blocked", async () => {
    const entries = loadInjections().filter((e) => e.set === set);
    const failures: string[] = [];
    const labels: string[] = [];
    for (const entry of entries) {
      const { decision } = await run(entry.text, SHAPES[entry.field]);
      const ok = entry.expect === "block" ? decision.outcome === "block" : decision.outcome !== "pass";
      if (!ok) {
        failures.push(`${entry.id}(${decision.outcome})`);
        labels.push(entry.family);
      }
    }
    console.info(`gate corpus ${set}: injections caught ${entries.length - failures.length}/${entries.length}`);
    expect(failures.length, report(set, failures, labels)).toBe(0);
  });

  it("flags fewer than 5% of clean traces and alters at most 2% of them", async () => {
    const entries = loadClean().filter((e) => e.set === set);
    const flagged: string[] = [];
    const flaggedLabels: string[] = [];
    const altered: string[] = [];
    const alteredLabels: string[] = [];
    for (const entry of entries) {
      const { decision } = await run(entry.text, SHAPES[entry.field]);
      if (decision.outcome !== "pass") {
        flagged.push(`${entry.id}(${decision.outcome})`);
        flaggedLabels.push(entry.field);
      }
      if (!entry.allowAltered && (decision.report.redactions as { total: number }).total > 0) {
        altered.push(entry.id);
        alteredLabels.push(entry.field);
      }
    }
    console.info(`gate corpus ${set}: clean flagged ${flagged.length}/${entries.length}, altered ${altered.length}/${entries.length}`);
    expect(flagged.length / entries.length, report(set, flagged, flaggedLabels)).toBeLessThan(0.05);
    expect(altered.length / entries.length, report(set, altered, alteredLabels)).toBeLessThanOrEqual(0.02);
  });
});
