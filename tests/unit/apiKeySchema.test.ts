import { describe, expect, it } from "vitest";
import { parseIssueKeyInput } from "@/lib/schemas/apiKey";

function value(raw: unknown) {
  const result = parseIssueKeyInput(raw);
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${JSON.stringify(result.detail)}`);
  return result.value;
}

describe("parseIssueKeyInput: accepted input", () => {
  it("returns scopes, expiry and label", () => {
    expect(value({ scopes: ["read", "cases:write"], expiresInDays: 30, label: "laptop" })).toEqual({
      scopes: ["read", "cases:write"],
      expiresInDays: 30,
      label: "laptop",
    });
  });

  it("defaults the expiry to 90 days when it is absent or undefined", () => {
    expect(value({ scopes: ["read"] }).expiresInDays).toBe(90);
    expect(value({ scopes: ["read"], expiresInDays: undefined }).expiresInDays).toBe(90);
  });

  it.each([30, 90, 365])("accepts an expiry of %s days", (days) => {
    expect(value({ scopes: ["read"], expiresInDays: days }).expiresInDays).toBe(days);
  });

  it("treats an explicit null expiry as never", () => {
    expect(value({ scopes: ["read"], expiresInDays: null }).expiresInDays).toBeNull();
  });

  it("removes duplicate scopes and puts them in the standard order", () => {
    expect(value({ scopes: ["arguments:write", "read", "read", "cases:write"] }).scopes).toEqual([
      "read",
      "cases:write",
      "arguments:write",
    ]);
  });

  it("trims the label, removes control characters and turns an empty label into null", () => {
    expect(value({ scopes: ["read"], label: "  ci\u0000 runner\u0007 " }).label).toBe("ci runner");
    expect(value({ scopes: ["read"], label: "   " }).label).toBeNull();
    expect(value({ scopes: ["read"] }).label).toBeNull();
    expect(value({ scopes: ["read"], label: null }).label).toBeNull();
  });

  it("accepts a label of exactly 60 characters", () => {
    expect(value({ scopes: ["read"], label: "l".repeat(60) }).label).toHaveLength(60);
  });

  it("ignores fields it does not know", () => {
    expect(Object.keys(value({ scopes: ["read"], agentId: "x", keyHash: "y" })).sort()).toEqual([
      "expiresInDays",
      "label",
      "scopes",
    ]);
  });
});

describe("parseIssueKeyInput: rejected input", () => {
  it.each([
    ["no scopes field", {}],
    ["an empty scope list", { scopes: [] }],
    ["an unknown scope", { scopes: ["read", "admin"] }],
    ["a scope in the wrong case", { scopes: ["Read"] }],
    ["scopes that are not an array", { scopes: "read" }],
    ["a non-text scope", { scopes: [1] }],
  ])("rejects %s", (_label, raw) => {
    const result = parseIssueKeyInput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid");
      expect(result.detail?.scopes).toBeTruthy();
    }
  });

  it.each([
    ["45 days", 45],
    ["zero days", 0],
    ["a negative number", -30],
    ["a numeric string", "90"],
    ["the word never", "never"],
    ["a fraction", 30.5],
  ])("rejects an expiry of %s", (_label, expiresInDays) => {
    const result = parseIssueKeyInput({ scopes: ["read"], expiresInDays });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail?.expiresInDays).toBeTruthy();
  });

  it("rejects a label of 61 characters", () => {
    const result = parseIssueKeyInput({ scopes: ["read"], label: "l".repeat(61) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail?.label).toBeTruthy();
  });

  it.each([[null], [undefined], ["text"], [42], [[]]])("rejects %j without throwing", (raw) => {
    expect(parseIssueKeyInput(raw).ok).toBe(false);
  });

  it("does not echo the input in its messages", () => {
    const result = parseIssueKeyInput({ scopes: ["LEAKME-scope"], label: "x".repeat(61) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.detail)).not.toContain("LEAKME");
  });
});
