import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyCronRequest } from "@/lib/http/cronAuth";

// Built from parts, like every secret in the tests.
const SECRET = ["cron", "secret", "value", "0123456789", "abcdef"].join("-");
const request = (authorization?: string) =>
  new Request("http://localhost:3000/api/cron/rescan", authorization === undefined ? {} : { headers: { authorization } });

describe("verifyCronRequest", () => {
  it("accepts exactly 'Bearer <secret>'", () => {
    expect(verifyCronRequest(request(`Bearer ${SECRET}`), SECRET)).toBe(true);
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["the Basic scheme", `Basic ${SECRET}`],
    ["a lower-case scheme", `bearer ${SECRET}`],
    ["an upper-case scheme", `BEARER ${SECRET}`],
    ["no scheme", SECRET],
    ["a wrong secret", `Bearer ${SECRET.slice(0, -1)}x`],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, 10)}`],
    ["the secret plus a character", `Bearer ${SECRET}x`],
    ["two spaces", `Bearer  ${SECRET}`],
    ["a bare scheme", "Bearer"],
    ["a bare scheme and a space", "Bearer "],
    ["non-ASCII text", "Bearer \u00f1\u00e9"],
    ["a very long header", `Bearer ${"a".repeat(10_000)}`],
  ] as const)("refuses %s", (_label, header) => {
    expect(verifyCronRequest(request(header), SECRET)).toBe(false);
  });

  it("refuses everything when no secret is configured", () => {
    expect(verifyCronRequest(request(`Bearer ${SECRET}`), null)).toBe(false);
    expect(verifyCronRequest(request("Bearer null"), null)).toBe(false);
    expect(verifyCronRequest(request("Bearer "), null)).toBe(false);
    expect(verifyCronRequest(request(undefined), null)).toBe(false);
  });

  it("refuses an empty secret, even for an empty token", () => {
    expect(verifyCronRequest(request("Bearer "), "")).toBe(false);
    expect(verifyCronRequest(request("Bearer"), "")).toBe(false);
  });

  it("ignores the query string and every other header", () => {
    const withExtras = new Request(`http://localhost:3000/api/cron/rescan?secret=${SECRET}&authorization=${SECRET}`, {
      headers: { "x-cron-secret": SECRET, cookie: `secret=${SECRET}` },
    });
    expect(verifyCronRequest(withExtras, SECRET)).toBe(false);
  });

  it("compares fixed-length digests in constant time", () => {
    const source = readFileSync("lib/http/cronAuth.ts", "utf8");
    expect(source).toMatch(/timingSafeEqual/);
    expect(source).toMatch(/createHash\(["']sha256["']\)/);
    expect(source).not.toMatch(/===\s*secret|secret\s*===|\.startsWith\(|\.includes\(/);
  });
});
