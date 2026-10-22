import { describe, expect, it } from "vitest";
import { parseArgumentInput } from "@/lib/schemas/argument";
import { parseCaseInput } from "@/lib/schemas/case";
import { parseEvidenceInput } from "@/lib/schemas/evidence";

const minimal = { title: "Tool call loops", summary: "The agent repeats a call.", expected: "One call.", actual: "Ten calls." };

function value<T>(result: { ok: true; value: T } | { ok: false; error: string; detail?: Record<string, string> }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${JSON.stringify(result.detail)}`);
  return result.value;
}

function detailOf(result: { ok: boolean; detail?: Record<string, string> }): Record<string, string> {
  if (result.ok) throw new Error("expected a failure");
  return result.detail ?? {};
}

describe("parseCaseInput: accepted input", () => {
  it("fills defaults for environment, tags and evidence", () => {
    expect(value(parseCaseInput(minimal))).toEqual({ ...minimal, environment: {}, tags: [], evidence: [] });
  });

  it("trims text and removes control characters but keeps newlines and tabs", () => {
    const parsed = value(parseCaseInput({ ...minimal, title: "  Hello  ", summary: "line1\n\tline2\u0000end" }));
    expect(parsed.title).toBe("Hello");
    expect(parsed.summary).toBe("line1\n\tline2end");
  });

  it("accepts the limits exactly", () => {
    expect(
      parseCaseInput({
        title: "a".repeat(200),
        summary: "a".repeat(4000),
        expected: "a".repeat(2000),
        actual: "a".repeat(2000),
      }).ok,
    ).toBe(true);
  });

  it("accepts slug tags, at most eight, and removes duplicates", () => {
    expect(value(parseCaseInput({ ...minimal, tags: ["tool-call", "gpt-4", "tool-call"] })).tags).toEqual([
      "tool-call",
      "gpt-4",
    ]);
    const eight = Array.from({ length: 8 }, (_, i) => `t${i}`);
    expect(value(parseCaseInput({ ...minimal, tags: eight })).tags).toEqual(eight);
  });

  it("accepts an environment and up to ten inline evidence items", () => {
    const evidence = Array.from({ length: 10 }, () => ({ kind: "trace", text: "step 1" }));
    const parsed = value(
      parseCaseInput({
        ...minimal,
        environment: { model: "model-a", framework: "fw", framework_version: "1.2", language: "ts", os: "linux", tools: ["a", "b"], notes: "n" },
        evidence,
      }),
    );
    expect(parsed.evidence).toHaveLength(10);
    expect(parsed.environment.tools).toEqual(["a", "b"]);
  });
});

describe("parseCaseInput: rejected input", () => {
  it.each([
    ["title", { title: "a".repeat(201) }],
    ["summary", { summary: "a".repeat(4001) }],
    ["expected", { expected: "a".repeat(2001) }],
    ["actual", { actual: "a".repeat(2001) }],
  ])("rejects a %s over its limit", (field, override) => {
    expect(detailOf(parseCaseInput({ ...minimal, ...override }))).toHaveProperty(field);
  });

  it.each([
    ["whitespace only", "   \n\t "],
    ["control characters only", "\u0000\u0007"],
    ["empty", ""],
  ])("rejects a title that is %s", (_label, title) => {
    expect(detailOf(parseCaseInput({ ...minimal, title }))).toHaveProperty("title");
  });

  it.each([
    ["missing title", { title: undefined }],
    ["number title", { title: 5 }],
    ["missing summary", { summary: undefined }],
  ])("rejects %s", (_label, override) => {
    expect(parseCaseInput({ ...minimal, ...override }).ok).toBe(false);
  });

  it.each([
    ["a sentence", ["fix the bug"]],
    ["upper case", ["Fix"]],
    ["33 characters", ["a".repeat(33)]],
    ["an empty tag", [""]],
    ["an underscore", ["under_score"]],
    ["nine tags", Array.from({ length: 9 }, (_, i) => `t${i}`)],
    ["not a list", "tool-call"],
  ])("rejects tags that are %s", (_label, tags) => {
    expect(detailOf(parseCaseInput({ ...minimal, tags }))).toHaveProperty("tags");
  });

  it.each(["operator_id", "agent_id", "status", "id"])("rejects the unknown field %s", (key) => {
    expect(detailOf(parseCaseInput({ ...minimal, [key]: "x" }))).toHaveProperty("form");
  });

  it.each([null, [], "text", 5, undefined])("rejects a body that is %j", (raw) => {
    expect(parseCaseInput(raw).ok).toBe(false);
  });

  it("rejects an unknown environment key, too many tools, a long tool name and a long note", () => {
    expect(detailOf(parseCaseInput({ ...minimal, environment: { secret: "x" } }))).toHaveProperty("environment");
    expect(
      detailOf(parseCaseInput({ ...minimal, environment: { tools: Array.from({ length: 21 }, () => "t") } })),
    ).toHaveProperty("environment");
    expect(detailOf(parseCaseInput({ ...minimal, environment: { tools: ["t".repeat(61)] } }))).toHaveProperty(
      "environment",
    );
    expect(detailOf(parseCaseInput({ ...minimal, environment: { notes: "n".repeat(501) } }))).toHaveProperty(
      "environment",
    );
  });

  it("limits the serialized environment to 4,096 UTF-8 bytes", () => {
    const fill = (char: string) => ({
      model: char.repeat(80),
      framework: char.repeat(80),
      framework_version: char.repeat(40),
      language: char.repeat(40),
      os: char.repeat(40),
      tools: Array.from({ length: 20 }, () => char.repeat(60)),
      notes: char.repeat(500),
    });
    expect(parseCaseInput({ ...minimal, environment: fill("a") }).ok).toBe(true);
    expect(detailOf(parseCaseInput({ ...minimal, environment: fill("\u20ac") }))).toHaveProperty("environment");
  });

  it("rejects eleven inline evidence items and a bad inline item", () => {
    const item = { kind: "trace", text: "x" };
    expect(detailOf(parseCaseInput({ ...minimal, evidence: Array.from({ length: 11 }, () => item) }))).toHaveProperty(
      "evidence",
    );
    expect(detailOf(parseCaseInput({ ...minimal, evidence: [{ kind: "log", text: "x" }] }))).toHaveProperty("evidence");
  });

  it("never puts the submitted value in the detail", () => {
    const marker = "SECRET_MARKER_12345";
    const result = parseCaseInput({
      ...minimal,
      summary: `${marker}${"a".repeat(4000)}`,
      tags: [`${marker} sentence`],
      environment: { notes: marker.repeat(100) },
      [marker]: "x",
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(detailOf(result))).not.toContain(marker);
  });
});

describe("parseEvidenceInput", () => {
  it.each(["trace", "prompt", "tool_schema", "error"])("accepts the kind %s", (kind) => {
    expect(value(parseEvidenceInput({ kind, text: "something" }))).toEqual({ kind, text: "something" });
  });

  it("rejects an unknown kind, empty text and unknown fields", () => {
    expect(detailOf(parseEvidenceInput({ kind: "log", text: "x" }))).toHaveProperty("kind");
    expect(detailOf(parseEvidenceInput({ kind: "trace", text: "  " }))).toHaveProperty("text");
    expect(detailOf(parseEvidenceInput({ kind: "trace", text: "x", case_id: "y" }))).toHaveProperty("form");
  });

  it("accepts 32,000 characters and rejects 32,001", () => {
    expect(parseEvidenceInput({ kind: "trace", text: "a".repeat(32000) }).ok).toBe(true);
    expect(detailOf(parseEvidenceInput({ kind: "trace", text: "a".repeat(32001) }))).toHaveProperty("text");
  });

  it.each([null, [], "text", undefined])("rejects a body that is %j", (raw) => {
    expect(parseEvidenceInput(raw).ok).toBe(false);
  });
});

describe("parseArgumentInput", () => {
  it("accepts both fields", () => {
    expect(value(parseArgumentInput({ reasoning: "Because.", proposed_change: "Set retries to 1." }))).toEqual({
      reasoning: "Because.",
      proposed_change: "Set retries to 1.",
    });
  });

  it("accepts 8,000 characters and rejects 8,001 in each field", () => {
    const ok = { reasoning: "a".repeat(8000), proposed_change: "a".repeat(8000) };
    expect(parseArgumentInput(ok).ok).toBe(true);
    expect(detailOf(parseArgumentInput({ ...ok, reasoning: "a".repeat(8001) }))).toHaveProperty("reasoning");
    expect(detailOf(parseArgumentInput({ ...ok, proposed_change: "a".repeat(8001) }))).toHaveProperty(
      "proposed_change",
    );
  });

  it("rejects a missing field, empty text and unknown fields", () => {
    expect(detailOf(parseArgumentInput({ reasoning: "Because." }))).toHaveProperty("proposed_change");
    expect(detailOf(parseArgumentInput({ reasoning: " ", proposed_change: "x" }))).toHaveProperty("reasoning");
    expect(detailOf(parseArgumentInput({ reasoning: "r", proposed_change: "c", agent_id: "x" }))).toHaveProperty("form");
  });

  it.each([null, [], "text", undefined])("rejects a body that is %j", (raw) => {
    expect(parseArgumentInput(raw).ok).toBe(false);
  });
});
