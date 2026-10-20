import { describe, expect, it } from "vitest";
import { agentFormToInput, issueKeyFormToInput } from "@/lib/dashboard/forms";
import { describeError } from "@/lib/dashboard/messages";

function form(entries: Array<[string, string | File]>): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

describe("issueKeyFormToInput", () => {
  it("reads scopes, expiry and label", () => {
    expect(
      issueKeyFormToInput(
        form([
          ["scopes", "read"],
          ["scopes", "cases:write"],
          ["expiresInDays", "30"],
          ["label", "laptop"],
        ]),
      ),
    ).toEqual({ scopes: ["read", "cases:write"], expiresInDays: 30, label: "laptop" });
  });

  it.each([
    ["30", 30],
    ["90", 90],
    ["365", 365],
    ["never", null],
  ])("turns the expiry choice %s into %s", (choice, expected) => {
    expect(issueKeyFormToInput(form([["scopes", "read"], ["expiresInDays", choice]])).expiresInDays).toBe(expected);
  });

  it("leaves the expiry out when it is missing or empty, so the default applies", () => {
    expect(issueKeyFormToInput(form([["scopes", "read"]])).expiresInDays).toBeUndefined();
    expect(issueKeyFormToInput(form([["scopes", "read"], ["expiresInDays", ""]])).expiresInDays).toBeUndefined();
  });

  it("passes an unknown expiry through unchanged, so validation rejects it", () => {
    expect(issueKeyFormToInput(form([["scopes", "read"], ["expiresInDays", "45"]])).expiresInDays).toBe("45");
    expect(issueKeyFormToInput(form([["scopes", "read"], ["expiresInDays", "abc"]])).expiresInDays).toBe("abc");
  });

  it("gives an empty scope list when none are ticked", () => {
    expect(issueKeyFormToInput(form([["label", "x"]])).scopes).toEqual([]);
  });

  it("ignores uploaded files and fields it does not know", () => {
    const input = issueKeyFormToInput(
      form([
        ["scopes", "read"],
        ["scopes", new File(["x"], "a.txt")],
        ["agentId", "someone-else"],
        ["keyHash", "x"],
      ]),
    );
    expect(input.scopes).toEqual(["read"]);
    expect(Object.keys(input).sort()).toEqual(["expiresInDays", "label", "scopes"]);
  });
});

describe("agentFormToInput", () => {
  it("reads the four text fields", () => {
    expect(
      agentFormToInput(
        form([
          ["handle", "scribe-01"],
          ["model", "model-a"],
          ["framework", "framework-b"],
          ["description", "Files cases."],
        ]),
      ),
    ).toEqual({ handle: "scribe-01", model: "model-a", framework: "framework-b", description: "Files cases." });
  });

  it("leaves missing fields out, and ignores files and unknown fields", () => {
    const input = agentFormToInput(form([["handle", "scribe-01"], ["model", new File(["x"], "m.txt")], ["role", "admin"]]));
    expect(input).toEqual({ handle: "scribe-01" });
  });
});

describe("describeError", () => {
  const known = [
    "operator_not_active",
    "agent_not_found",
    "agent_not_active",
    "agent_limit",
    "handle_taken",
    "key_limit",
    "key_not_found",
    "invalid",
    "origin_mismatch",
    "not_signed_in",
  ];

  it.each(known)("gives %s a code, a message and a hint", (error) => {
    const described = describeError(error);
    expect(described.code).toBe(error);
    expect(described.message.length).toBeGreaterThan(0);
    expect(described.hint.length).toBeGreaterThan(0);
  });

  it("gives actionable hints", () => {
    expect(describeError("agent_limit").hint).toMatch(/5 agents/);
    expect(describeError("key_limit").hint).toMatch(/revoke/i);
    expect(describeError("handle_taken").hint).toMatch(/another/i);
    expect(describeError("operator_not_active").hint).toMatch(/pending|30 days/i);
    expect(describeError("origin_mismatch").hint).toMatch(/reload/i);
  });

  it("turns an unknown error into a generic one without echoing it", () => {
    const described = describeError("db exploded: password=LEAKME");
    expect(described.code).toBe("unexpected_error");
    expect(JSON.stringify(described)).not.toContain("LEAKME");
  });
});
