import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "@/lib/schemas/search";

const params = (init: Record<string, string> | string) => new URLSearchParams(init);

function failure(result: ReturnType<typeof parseSearchQuery>): Record<string, string> {
  if (result.ok) throw new Error("expected a failure");
  expect(result.error).toBe("invalid");
  return result.detail ?? {};
}

describe("parseSearchQuery", () => {
  it("reads the query and applies the default limit of 10", () => {
    expect(parseSearchQuery(params({ q: "tool call loop" }))).toEqual({ ok: true, value: { query: "tool call loop", limit: 10 } });
  });

  it("trims the query and removes control characters", () => {
    const result = parseSearchQuery(params({ q: "  retry\u0000 loop\u0007  " }));
    expect(result).toEqual({ ok: true, value: { query: "retry loop", limit: 10 } });
  });

  it("keeps newlines and tabs inside the query", () => {
    expect(parseSearchQuery(params({ q: "a\tb" }))).toMatchObject({ ok: true, value: { query: "a\tb" } });
  });

  it("accepts 200 characters and refuses 201", () => {
    expect(parseSearchQuery(params({ q: "a".repeat(200) })).ok).toBe(true);
    expect(Object.keys(failure(parseSearchQuery(params({ q: "a".repeat(201) }))))).toEqual(["q"]);
  });

  it("measures the length after cleaning, so control characters do not count", () => {
    expect(parseSearchQuery(params({ q: `${"a".repeat(200)}\u0000\u0000` })).ok).toBe(true);
  });

  it.each([
    ["missing", ""],
    ["empty", "q="],
    ["blank", "q=%20%20%20"],
    ["only control characters", "q=%00%07"],
  ])("refuses a %s query, naming only the field", (_label, query) => {
    expect(Object.keys(failure(parseSearchQuery(params(query))))).toEqual(["q"]);
  });

  it("takes the first q when it is given twice", () => {
    expect(parseSearchQuery(params("q=first&q=second"))).toMatchObject({ ok: true, value: { query: "first" } });
  });

  it.each(["1", "10", "20"])("accepts limit %s", (limit) => {
    expect(parseSearchQuery(params({ q: "x", limit }))).toMatchObject({ ok: true, value: { limit: Number(limit) } });
  });

  it.each(["0", "21", "-1", "abc", "1.5", "1e1", "", " 5", "05", "100000"])("refuses limit %j", (limit) => {
    expect(Object.keys(failure(parseSearchQuery(params({ q: "x", limit }))))).toEqual(["limit"]);
  });

  it("reports every problem at once", () => {
    expect(Object.keys(failure(parseSearchQuery(params({ limit: "0" })))).sort()).toEqual(["limit", "q"]);
  });

  it("ignores parameters it does not know", () => {
    expect(parseSearchQuery(params({ q: "x", status: "open", cursor: "zzz", anything: "else" })).ok).toBe(true);
  });

  it("never puts the submitted text in a message", () => {
    const hostile = "<script>alert(1)</script>".repeat(20);
    const detail = failure(parseSearchQuery(params({ q: hostile, limit: hostile })));
    expect(JSON.stringify(detail)).not.toContain("script");
    expect(JSON.stringify(detail)).not.toContain("alert");
  });
});
