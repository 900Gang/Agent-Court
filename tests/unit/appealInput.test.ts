import { describe, expect, it } from "vitest";
import { parseAppealInput } from "@/lib/schemas/appeal";

const CASE = "00000000-0000-4000-8000-000000000001";
const REASON = "The fix did not hold: the loop returned on the second run.";
const good = { caseId: CASE, reason: REASON };

describe("parseAppealInput", () => {
  it("accepts a case id and a reason", () => {
    expect(parseAppealInput(good)).toEqual({ ok: true, value: { caseId: CASE, reason: REASON } });
  });

  it("ignores fields it does not know", () => {
    expect(parseAppealInput({ ...good, verdictId: "x", status: "overturned", outcome: "overturned" })).toEqual({
      ok: true,
      value: { caseId: CASE, reason: REASON },
    });
  });

  it.each([[undefined], [null], [""], ["not-a-uuid"], ["../admin"], [12345], [{}], [[CASE]]])("refuses a case id of %j and names only that field", (caseId) => {
    const result = parseAppealInput({ ...good, caseId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.detail ?? {})).toEqual(["caseId"]);
  });

  it("names both fields when both are bad", () => {
    const result = parseAppealInput({ caseId: "x", reason: "short" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.detail ?? {}).sort()).toEqual(["caseId", "reason"]);
  });

  it.each([[null], [undefined], ["text"], [42], [[]]])("refuses input that is not an object (%j)", (raw) => {
    const result = parseAppealInput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.detail ?? {}).sort()).toEqual(["caseId", "reason"]);
  });
});

describe("parseAppealInput: the reason", () => {
  it.each([
    [9, false],
    [10, true],
    [11, true],
    [499, true],
    [500, true],
    [501, false],
  ])("a reason of %i characters is accepted: %s", (length, accepted) => {
    expect(parseAppealInput({ caseId: CASE, reason: "r".repeat(length) }).ok).toBe(accepted);
  });

  it("measures the length after trimming and after hidden characters are removed", () => {
    expect(parseAppealInput({ caseId: CASE, reason: `   ${"r".repeat(9)}   ` }).ok).toBe(false);
    expect(parseAppealInput({ caseId: CASE, reason: `${"r".repeat(9)}​​​` }).ok).toBe(false);
    const padded = parseAppealInput({ caseId: CASE, reason: `   ${"r".repeat(10)}   ` });
    expect(padded).toEqual({ ok: true, value: { caseId: CASE, reason: "r".repeat(10) } });
  });

  it.each([[undefined], [null], [""], ["   "], ["\n\t"], [12345], [{}], [["a long enough reason"]]])("refuses a reason of %j and names the field", (reason) => {
    const result = parseAppealInput({ caseId: CASE, reason });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.detail ?? {})).toEqual(["reason"]);
  });

  it("keeps a hostile reason as plain data", () => {
    const hostile = '<script>alert(1)</script> [x](javascript:alert(1)) "quoted" & more words here';
    const result = parseAppealInput({ caseId: CASE, reason: hostile });
    expect(result).toEqual({ ok: true, value: { caseId: CASE, reason: hostile } });
  });

  it("states the rule in the refusal and never quotes the input", () => {
    const marker = "PLANTED_9"; // nine characters: one too short to be a reason
    const result = parseAppealInput({ caseId: "x", reason: marker });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = JSON.stringify(result.detail);
      expect(text).toContain("10");
      expect(text).toContain("500");
      expect(text).not.toContain(marker);
    }
  });
});
