import { describe, expect, it } from "vitest";
import { createGate } from "@/lib/safety/engine";
import { applyCaseFields, caseGateFields, summarizeRedactions } from "@/lib/safety/fields";
import type { GateDecision } from "@/lib/safety/gate";
import { describeField } from "@/lib/safety/limits";
import type { CaseInput } from "@/lib/schemas/case";

const base: CaseInput = {
  title: "Tool call loops",
  summary: "The agent repeats a call.",
  expected: "One call.",
  actual: "Ten calls.",
  environment: {},
  tags: [],
  evidence: [],
};

const full: CaseInput = {
  ...base,
  environment: {
    model: "model-a",
    framework: "framework-b",
    framework_version: "1.2.3",
    language: "typescript",
    os: "Windows 11",
    tools: ["search", "calculator"],
    notes: "Ran on a laptop.",
  },
  tags: ["tool-call", "retry"],
};

const decision = (redactions: unknown): GateDecision => ({
  outcome: "pass",
  fields: {},
  report: redactions === undefined ? {} : { redactions },
});

describe("caseGateFields", () => {
  it("names the four text fields and nothing else for a bare case", () => {
    expect(caseGateFields(base)).toEqual({
      title: base.title,
      summary: base.summary,
      expected: base.expected,
      actual: base.actual,
    });
  });

  it("adds a field for every environment value and every tool and tag, by position", () => {
    expect(caseGateFields(full)).toEqual({
      title: full.title,
      summary: full.summary,
      expected: full.expected,
      actual: full.actual,
      "environment.model": "model-a",
      "environment.framework": "framework-b",
      "environment.framework_version": "1.2.3",
      "environment.language": "typescript",
      "environment.os": "Windows 11",
      "environment.notes": "Ran on a laptop.",
      "environment.tools.0": "search",
      "environment.tools.1": "calculator",
      "tag.0": "tool-call",
      "tag.1": "retry",
    });
  });

  it("leaves out environment keys that are absent", () => {
    const names = Object.keys(caseGateFields({ ...base, environment: { os: "Linux" } }));
    expect(names).toContain("environment.os");
    expect(names).not.toContain("environment.model");
    expect(names).not.toContain("environment.notes");
  });

  it("builds only names that describeField accepts, so the real gate never throws on them", () => {
    for (const name of Object.keys(caseGateFields(full))) {
      expect(() => describeField("case", name)).not.toThrow();
    }
  });

  it("is accepted by the real gate and a clean case passes", async () => {
    const result = await createGate().screen({ target: "case", fields: caseGateFields(full) });
    expect(result.outcome).toBe("pass");
    expect(result.fields).toEqual(caseGateFields(full));
  });
});

describe("applyCaseFields", () => {
  it("rebuilds the same case from unchanged fields", () => {
    for (const input of [base, full, { ...base, environment: { tools: [] } }]) {
      const rebuilt = applyCaseFields(input, caseGateFields(input));
      expect(rebuilt).toStrictEqual({
        title: input.title,
        summary: input.summary,
        expected: input.expected,
        actual: input.actual,
        environment: input.environment,
        tags: input.tags,
        droppedTags: 0,
      });
    }
  });

  it("takes every text, environment and tool value from the returned fields", () => {
    const fields = {
      ...caseGateFields(full),
      title: "new title",
      "environment.model": "model-z",
      "environment.notes": "new notes",
      "environment.tools.1": "new tool",
    };
    const rebuilt = applyCaseFields(full, fields);
    expect(rebuilt.title).toBe("new title");
    expect(rebuilt.environment).toStrictEqual({ ...full.environment, model: "model-z", notes: "new notes", tools: ["search", "new tool"] });
  });

  it("drops a tag whose returned text differs, and counts it", () => {
    const fields = { ...caseGateFields(full), "tag.0": "[REDACTED:email]" };
    const rebuilt = applyCaseFields(full, fields);
    expect(rebuilt.tags).toEqual(["retry"]);
    expect(rebuilt.droppedTags).toBe(1);
  });

  it("drops every tag the gate changed", () => {
    const fields = { ...caseGateFields(full), "tag.0": "a", "tag.1": "b" };
    const rebuilt = applyCaseFields(full, fields);
    expect(rebuilt.tags).toEqual([]);
    expect(rebuilt.droppedTags).toBe(2);
  });

  it("removes duplicate tags", () => {
    const input = { ...base, tags: ["a", "b", "a"] };
    const rebuilt = applyCaseFields(input, caseGateFields(input));
    expect(rebuilt.tags).toEqual(["a", "b"]);
    expect(rebuilt.droppedTags).toBe(0);
  });
});

describe("summarizeRedactions", () => {
  it("is zero for no decisions", () => {
    expect(summarizeRedactions([])).toEqual({ total: 0, types: {} });
  });

  it("adds totals and merges types across decisions", () => {
    const summary = summarizeRedactions([
      decision({ total: 2, types: { email: 1, phone: 1 } }),
      decision({ total: 1, types: { email: 1 } }),
      decision({ total: 0, types: {} }),
    ]);
    expect(summary).toEqual({ total: 3, types: { email: 2, phone: 1 } });
  });

  it("counts a decision without a redaction report as zero", () => {
    expect(summarizeRedactions([decision(undefined), decision("lots"), decision(null), decision({ total: "x" })])).toEqual({
      total: 0,
      types: {},
    });
  });

  it("reads what the real gate reports", async () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const real = await createGate().screen({
      target: "case",
      fields: { ...caseGateFields(base), summary: `The shell history held ${key} and nothing else worth reading in it.` },
    });
    expect(summarizeRedactions([real])).toEqual({ total: 1, types: { aws_access_key: 1 } });
  });
});
