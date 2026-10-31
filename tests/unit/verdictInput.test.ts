import { describe, expect, it } from "vitest";
import { parseVerdictInput } from "@/lib/schemas/verdict";

const CASE = "00000000-0000-4000-8000-000000000001";
const ARGUMENT = "00000000-0000-4000-8000-000000000002";
const good = { caseId: CASE, winningArgumentId: ARGUMENT };

describe("parseVerdictInput: the ids", () => {
  it("accepts two UUIDs and no note", () => {
    expect(parseVerdictInput(good)).toEqual({ ok: true, value: { caseId: CASE, winningArgumentId: ARGUMENT, note: null } });
  });

  it("ignores fields it does not know", () => {
    expect(parseVerdictInput({ ...good, level: "operator_confirmed", status: "won", decidedBy: "auto" })).toEqual({
      ok: true,
      value: { caseId: CASE, winningArgumentId: ARGUMENT, note: null },
    });
  });

  it.each([[undefined], [null], [""], ["not-a-uuid"], ["../admin"], [12345], [{}], [[CASE]]])("refuses a case id of %j and names the field", (caseId) => {
    const result = parseVerdictInput({ ...good, caseId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.detail ?? {})).toEqual(["caseId"]);
  });

  it.each([[undefined], [null], [""], ["not-a-uuid"], [12345]])("refuses a winning argument id of %j and names the field", (winningArgumentId) => {
    const result = parseVerdictInput({ ...good, winningArgumentId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.detail ?? {})).toEqual(["winningArgumentId"]);
  });

  it("names both fields when both are bad", () => {
    const result = parseVerdictInput({ caseId: "x", winningArgumentId: "y" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.detail ?? {}).sort()).toEqual(["caseId", "winningArgumentId"]);
  });

  it.each([[null], [undefined], ["text"], [42], [[]]])("refuses input that is not an object (%j)", (raw) => {
    const result = parseVerdictInput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.detail ?? {}).sort()).toEqual(["caseId", "winningArgumentId"]);
  });
});

describe("parseVerdictInput: the note", () => {
  it.each([[undefined], [null], [""], ["   "], ["\u0000\u200b"]])("treats %j as no note", (note) => {
    expect(parseVerdictInput({ ...good, note })).toEqual({ ok: true, value: { caseId: CASE, winningArgumentId: ARGUMENT, note: null } });
  });

  it("trims a note and removes control and hidden characters", () => {
    const result = parseVerdictInput({ ...good, note: "  Fixed\u0000 it \u200b " });
    expect(result).toEqual({ ok: true, value: { caseId: CASE, winningArgumentId: ARGUMENT, note: "Fixed it" } });
  });

  it("accepts 500 characters and refuses 501, naming the field", () => {
    expect(parseVerdictInput({ ...good, note: "a".repeat(500) }).ok).toBe(true);
    const result = parseVerdictInput({ ...good, note: "a".repeat(501) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.detail ?? {})).toEqual(["note"]);
  });

  it.each([[12345], [true], [{ text: "x" }], [["x"]]])("refuses a note that is not text (%j)", (note) => {
    const result = parseVerdictInput({ ...good, note });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.detail ?? {})).toEqual(["note"]);
  });

  it("never puts the input into a refusal", () => {
    const hostile = "<script>alert(1)</script>SENTINEL_INPUT";
    const result = parseVerdictInput({ caseId: hostile, winningArgumentId: hostile, note: `${hostile}${"x".repeat(600)}` });
    expect(JSON.stringify(result)).not.toContain("SENTINEL_INPUT");
    expect(JSON.stringify(result)).not.toContain("script");
  });
});
