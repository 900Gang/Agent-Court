import { describe, expect, it } from "vitest";
import { parseAgentInput } from "@/lib/schemas/agent";

function value(raw: unknown) {
  const result = parseAgentInput(raw);
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${JSON.stringify(result.detail)}`);
  return result.value;
}

describe("parseAgentInput: accepted input", () => {
  it("returns the four fields", () => {
    expect(
      value({ handle: "scribe-01", model: "model-a", framework: "framework-b", description: "Files cases." }),
    ).toEqual({
      handle: "scribe-01",
      model: "model-a",
      framework: "framework-b",
      description: "Files cases.",
    });
  });

  it("turns omitted optional fields into null", () => {
    expect(value({ handle: "scribe-01" })).toEqual({
      handle: "scribe-01",
      model: null,
      framework: null,
      description: null,
    });
  });

  it("trims and lower-cases the handle", () => {
    expect(value({ handle: "  Scribe-01 " }).handle).toBe("scribe-01");
  });

  it("turns empty and whitespace-only optional fields into null", () => {
    expect(value({ handle: "scribe-01", model: "", framework: "   ", description: "\n" })).toMatchObject({
      model: null,
      framework: null,
      description: null,
    });
  });

  it("ignores fields it does not know", () => {
    expect(Object.keys(value({ handle: "scribe-01", role: "admin", operatorId: "x" })).sort()).toEqual([
      "description",
      "framework",
      "handle",
      "model",
    ]);
  });

  it("accepts the longest allowed values", () => {
    expect(() =>
      value({
        handle: `a${"b".repeat(31)}`,
        model: "m".repeat(80),
        framework: "f".repeat(80),
        description: "d".repeat(500),
      }),
    ).not.toThrow();
  });

  it("removes control characters but keeps newlines and tabs", () => {
    const cleaned = value({ handle: "scribe-01", description: "a\u0000b\u0007c\u001bd\ne\tf\u007f" });
    expect(cleaned.description).toBe("abcd\ne\tf");
  });
});

describe("parseAgentInput: rejected input", () => {
  it.each([
    ["too short", "ab"],
    ["too long", `a${"b".repeat(32)}`],
    ["a leading hyphen", "-abc"],
    ["an underscore", "a_b"],
    ["a space", "a b"],
    ["empty", ""],
    ["a non-ASCII letter", "scríbe"],
    ["the reserved name admin", "admin"],
    ["a reserved name in capitals", "System"],
    ["the reserved name importer", "importer"],
    ["the reserved name court", "court"],
    ["the reserved name agent-court", "agent-court"],
    ["the reserved prefix system-", "system-bot"],
    ["the reserved prefix seed-", "seed-agent-z"],
  ])("rejects a handle that is %s", (_label, handle) => {
    const result = parseAgentInput({ handle });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid");
      expect(result.detail?.handle).toBeTruthy();
    }
  });

  it.each([
    ["model of 81 characters", { model: "m".repeat(81) }, "model"],
    ["framework of 81 characters", { framework: "f".repeat(81) }, "framework"],
    ["description of 501 characters", { description: "d".repeat(501) }, "description"],
  ])("rejects a %s", (_label, extra, field) => {
    const result = parseAgentInput({ handle: "scribe-01", ...extra });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail?.[field]).toBeTruthy();
  });

  it.each([
    ["a missing handle", {}],
    ["a numeric handle", { handle: 123 }],
    ["an object as the model", { handle: "scribe-01", model: {} }],
    ["an array as the description", { handle: "scribe-01", description: ["x"] }],
  ])("rejects %s", (_label, raw) => {
    expect(parseAgentInput(raw).ok).toBe(false);
  });

  it.each([[null], [undefined], ["text"], [42], [[]]])("rejects %j without throwing", (raw) => {
    expect(parseAgentInput(raw).ok).toBe(false);
  });

  it("does not echo the input in its messages", () => {
    const result = parseAgentInput({ handle: "bad handle LEAKME", description: "x".repeat(501) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.detail)).not.toContain("LEAKME");
  });
});
