import { describe, expect, it } from "vitest";
import { OriginError, assertSameOrigin } from "@/lib/http/origin";

const expected = "http://localhost:3000";
const check = (headers: Record<string, string>, expectedOrigin = expected) =>
  assertSameOrigin(new Headers(headers), expectedOrigin);

describe("assertSameOrigin: accepted", () => {
  it("accepts a matching Origin", () => {
    expect(() => check({ origin: "http://localhost:3000" })).not.toThrow();
  });

  it("ignores a trailing slash or path on the expected origin", () => {
    expect(() => check({ origin: "http://localhost:3000" }, "http://localhost:3000/")).not.toThrow();
    expect(() => check({ origin: "http://localhost:3000" }, "http://localhost:3000/dashboard")).not.toThrow();
  });

  it("treats the default port and letter case as the same origin", () => {
    expect(() => check({ origin: "https://agent-court.example:443" }, "https://agent-court.example")).not.toThrow();
    expect(() => check({ origin: "HTTP://LOCALHOST:3000" })).not.toThrow();
  });

  it("falls back to the origin of the Referer when there is no Origin", () => {
    expect(() => check({ referer: "http://localhost:3000/dashboard/agents?x=1" })).not.toThrow();
  });

  it("prefers Origin over Referer", () => {
    expect(() =>
      check({ origin: "http://localhost:3000", referer: "https://evil.example/page" }),
    ).not.toThrow();
  });
});

describe("assertSameOrigin: rejected", () => {
  it.each([
    ["a different host", { origin: "http://evil.example" }],
    ["a different port", { origin: "http://localhost:3001" }],
    ["a different scheme", { origin: "https://localhost:3000" }],
    ["a look-alike host", { origin: "http://localhost:3000.evil.example" }],
    ["the string null", { origin: "null" }],
    ["a malformed value", { origin: "not a url" }],
    ["an empty Origin and no Referer", { origin: "" }],
    ["a Referer from another site", { referer: "https://evil.example/localhost:3000" }],
    ["a malformed Referer", { referer: "::::" }],
    ["neither header", {}],
  ])("rejects %s", (_label, headers) => {
    expect(() => check(headers)).toThrow(OriginError);
  });

  it("rejects a mismatched Origin even when the Referer matches", () => {
    expect(() =>
      check({ origin: "https://evil.example", referer: "http://localhost:3000/dashboard" }),
    ).toThrow(OriginError);
  });

  it("throws an OriginError with a fixed message that does not echo the header", () => {
    try {
      check({ origin: "http://evil-LEAKME.example" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OriginError);
      expect((error as Error).name).toBe("OriginError");
      expect((error as Error).message).not.toContain("LEAKME");
    }
  });
});
