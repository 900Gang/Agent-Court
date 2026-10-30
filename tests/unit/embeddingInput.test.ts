import { describe, expect, it } from "vitest";
import { buildEmbeddingInput, checkInput, hashEmbeddingInput } from "@/lib/embeddings/input";

const aws = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

const base = {
  title: "Retry loop ignores Retry-After",
  summary: "After a 429 the agent retries at once.",
  expected: "It waits for the Retry-After interval.",
  actual: "It sends 40 identical requests in 10 seconds.",
  environment: { model: "example-model", framework: "example-framework", language: "TypeScript" } as unknown,
  tags: ["rate-limit", "retry-loop"],
};

describe("buildEmbeddingInput", () => {
  it("holds the title, the summary, expected, actual, the three environment facts and the tags", () => {
    const input = buildEmbeddingInput(base);
    for (const part of [base.title, base.summary, base.expected, base.actual, "example-model", "example-framework", "TypeScript", "rate-limit", "retry-loop"]) {
      expect(input, part).toContain(part);
    }
  });

  it("is the same text every time for the same case", () => {
    expect(buildEmbeddingInput(base)).toBe(buildEmbeddingInput({ ...base, tags: [...base.tags] }));
  });

  it("changes when any field changes", () => {
    const original = buildEmbeddingInput(base);
    const variants = [
      { ...base, title: `${base.title}!` },
      { ...base, summary: `${base.summary}!` },
      { ...base, expected: `${base.expected}!` },
      { ...base, actual: `${base.actual}!` },
      { ...base, tags: ["rate-limit"] },
      { ...base, environment: { model: "other-model", framework: "example-framework", language: "TypeScript" } },
    ];
    for (const variant of variants) expect(buildEmbeddingInput(variant)).not.toBe(original);
  });

  it("leaves out every environment key except model, framework and language", () => {
    const input = buildEmbeddingInput({
      ...base,
      environment: {
        model: "m",
        framework: "f",
        language: "l",
        os: "SENTINEL_OS",
        notes: "SENTINEL_NOTES",
        framework_version: "SENTINEL_VERSION",
        tools: ["SENTINEL_TOOL"],
        anything_else: "SENTINEL_OTHER",
      },
    });
    expect(input).not.toContain("SENTINEL");
    for (const kept of ["m", "f", "l"]) expect(input).toContain(kept);
  });

  it("leaves out an environment value that is not text", () => {
    const input = buildEmbeddingInput({ ...base, environment: { model: { evil: "SENTINEL_OBJECT" }, framework: 7071, language: ["SENTINEL_LIST"] } });
    expect(input).not.toContain("SENTINEL");
    expect(input).not.toContain("7071");
  });

  it.each([[null], [undefined], [[]], ["a string"], [7], [{}]])("copes with an environment of %j", (environment) => {
    expect(() => buildEmbeddingInput({ ...base, environment })).not.toThrow();
    expect(buildEmbeddingInput({ ...base, environment })).toContain(base.title);
  });

  it("copes with no tags", () => {
    expect(buildEmbeddingInput({ ...base, tags: [] })).toContain(base.title);
  });

  it("stays well under the model limit for fields at their maximum size", () => {
    const input = buildEmbeddingInput({
      title: "t".repeat(200),
      summary: "s".repeat(4000),
      expected: "e".repeat(2000),
      actual: "a".repeat(2000),
      environment: { model: "m".repeat(80), framework: "f".repeat(80), language: "l".repeat(40) },
      tags: Array.from({ length: 8 }, (_, i) => `tag${i}`.padEnd(32, "x")),
    });
    expect(input.length).toBeLessThan(10000);
  });
});

describe("hashEmbeddingInput", () => {
  it("is a stable 64-character hex digest", () => {
    expect(hashEmbeddingInput("model-a", "some text")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashEmbeddingInput("model-a", "some text")).toBe(hashEmbeddingInput("model-a", "some text"));
  });

  it("differs when the text differs or the model differs", () => {
    expect(hashEmbeddingInput("model-a", "some text")).not.toBe(hashEmbeddingInput("model-a", "other text"));
    expect(hashEmbeddingInput("model-a", "some text")).not.toBe(hashEmbeddingInput("model-b", "some text"));
  });

  it("cannot be fooled by moving text from the model name into the input", () => {
    expect(hashEmbeddingInput("ab", "c")).not.toBe(hashEmbeddingInput("a", "bc"));
  });
});

describe("checkInput: the second redaction pass", () => {
  it("accepts ordinary text and text that already holds placeholders", () => {
    expect(checkInput("The agent retries a failing call forever.")).toEqual({ ok: true });
    expect(checkInput(`The log printed [REDACTED:aws_access_key] and [REDACTED:github_token] in a header.`)).toEqual({ ok: true });
  });

  it("refuses text that still holds a secret, and names the rule, never the text", () => {
    const result = checkInput(`The failing call logged ${aws} in clear text.`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rules).toContain("aws_access_key");
      expect(JSON.stringify(result)).not.toContain(aws);
    }
  });

  it("refuses text with hidden characters that the gate should have removed", () => {
    const result = checkInput(`A title with a zero\u200bwidth space`);
    expect(result.ok).toBe(false);
  });
});
