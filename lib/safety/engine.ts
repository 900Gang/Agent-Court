import type { GateDecision, GateInput, GateOutcome, SafetyGate } from "./gate";
import { scoreInjection, type InjectionHit } from "./injection";
import { describeField } from "./limits";
import { linkScore, scanLinks, type LinkScan } from "./links";
import { normalizeText, type Stripped } from "./normalize";
import { redactedRatio, redactText, type RedactionItem } from "./redact";
import { INJECTION_BLOCK_SCORE, INJECTION_FLAG_SCORE, REDACTION_BLOCK_RATIO } from "./thresholds";
import { GATE_VERSION } from "./version";

export type GateStep = "normalize" | "limits" | "redact" | "injection" | "links" | "outcome";

/** What the gate found in one field. Rule ids, counts and positions only: never any text. */
export type FieldReport = {
  outcome: GateOutcome;
  stripped: Stripped;
  score: number;
  hits: InjectionHit[];
  redactions: RedactionItem[];
  links: LinkScan;
};

const SEVERITY: Record<GateOutcome, number> = { pass: 0, flag: 1, block: 2 };

/**
 * The safety gate. Each field goes through the same steps in the same order: normalize, check the size limit,
 * redact secrets, score injection, scan links, decide. The overall outcome is the most severe field outcome.
 * `screen` throws on an unknown field or a failing step; wrap it with `screenSafely` so any failure becomes `flag`.
 */
export function createGate(options: { trace?: (step: GateStep, field: string) => void } = {}): SafetyGate {
  return {
    async screen(input: GateInput): Promise<GateDecision> {
      const fields: Record<string, string> = {};
      const reports: Record<string, FieldReport> = {};
      const types: Record<string, number> = {};
      let totalRedactions = 0;
      let overall: GateOutcome = "pass";

      for (const [name, raw] of Object.entries(input.fields)) {
        const step = (which: GateStep) => options.trace?.(which, name);

        step("normalize");
        const normalized = normalizeText(raw);

        step("limits");
        const { limit, kind } = describeField(input.target, name, input.context);

        step("redact");
        const redacted = redactText(normalized.text);
        const ratio = redactedRatio(normalized.text, redacted.items);

        step("injection");
        const injection = scoreInjection(redacted.text, { kind, stripped: normalized.stripped });

        step("links");
        const links = scanLinks(redacted.text);

        step("outcome");
        const score = injection.score + linkScore(links);
        const tagChanged = kind === "tag" && (normalized.text !== raw || redacted.items.length > 0);
        let outcome: GateOutcome = "pass";
        // A tag is a short slug: when redaction changes it, the case is flagged and the tag dropped, not blocked.
        const secretDump = kind !== "tag" && ratio > REDACTION_BLOCK_RATIO;
        if (normalized.text.length > limit || secretDump || score >= INJECTION_BLOCK_SCORE) {
          outcome = "block";
        } else if (score >= INJECTION_FLAG_SCORE || normalized.stripped.tag > 0 || tagChanged) {
          outcome = "flag";
        }

        fields[name] = redacted.text;
        reports[name] = {
          outcome,
          stripped: normalized.stripped,
          score,
          hits: injection.hits,
          redactions: redacted.items,
          links,
        };
        for (const item of redacted.items) {
          types[item.type] = (types[item.type] ?? 0) + 1;
          totalRedactions++;
        }
        if (SEVERITY[outcome] > SEVERITY[overall]) overall = outcome;
      }

      return {
        outcome: overall,
        fields,
        report: {
          version: GATE_VERSION,
          outcome: overall,
          redactions: { total: totalRedactions, types },
          fields: reports,
        },
      };
    },
  };
}
