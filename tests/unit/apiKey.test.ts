import { describe, expect, it } from "vitest";
import {
  extractBearerKey,
  generateApiKey,
  hashApiKey,
  isWellFormedKey,
} from "@/lib/auth/apiKey";

const KEY = `ac_live_${"A1".repeat(16)}`; // 8 + 32 characters

describe("generateApiKey", () => {
  it("produces ac_live_ followed by 32 base62 characters", () => {
    expect(generateApiKey().key).toMatch(/^ac_live_[0-9A-Za-z]{32}$/);
  });

  it("never repeats", () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateApiKey().key));
    expect(keys.size).toBe(1000);
  });

  it("uses the first 12 characters as the prefix", () => {
    const { key, prefix } = generateApiKey();
    expect(prefix).toBe(key.slice(0, 12));
    expect(prefix.startsWith("ac_live_")).toBe(true);
  });

  it("returns the hash of the key, as 64 lowercase hex characters", () => {
    const { key, hash } = generateApiKey();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashApiKey(key));
  });

  it("does not put any of the key in the hash", () => {
    const { key, hash } = generateApiKey();
    expect(hash).not.toContain(key.slice(8, 20));
  });

  it("uses all 62 characters about equally often (no modulo bias)", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      for (const char of generateApiKey().key.slice(8)) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(62);
    // 64000 characters over 62 symbols: about 1032 each, standard deviation about 32.
    for (const [char, count] of counts) {
      expect(count, `character ${char}`).toBeGreaterThan(800);
      expect(count, `character ${char}`).toBeLessThan(1300);
    }
  });
});

describe("hashApiKey", () => {
  it("is SHA-256 of the exact key, as lowercase hex", () => {
    expect(hashApiKey("ac_live_abcdefghijklmnopqrstuvwxyz012345")).toBe(
      "1fb370b02806e4de56b6cb3f2e961dc7dd13d5945c9cb9f0f2741096fdb0c909",
    );
  });

  it("is deterministic and sensitive to every character", () => {
    expect(hashApiKey(KEY)).toBe(hashApiKey(KEY));
    expect(hashApiKey(KEY)).not.toBe(hashApiKey(`${KEY} `));
    expect(hashApiKey(KEY)).not.toBe(hashApiKey(KEY.slice(0, -1) + "2"));
  });
});

describe("isWellFormedKey", () => {
  it("accepts a key with a 32 character base62 body", () => {
    expect(isWellFormedKey(KEY)).toBe(true);
    expect(isWellFormedKey(generateApiKey().key)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["a 31 character body", `ac_live_${"a".repeat(31)}`],
    ["a 33 character body", `ac_live_${"a".repeat(33)}`],
    ["a symbol in the body", `ac_live_${"a".repeat(31)}-`],
    ["an underscore in the body", `ac_live_${"a".repeat(31)}_`],
    ["a test key prefix", `ac_test_${"a".repeat(32)}`],
    ["an upper case prefix", `AC_LIVE_${"a".repeat(32)}`],
    ["no prefix", "a".repeat(40)],
    ["leading whitespace", ` ${KEY}`],
    ["trailing whitespace", `${KEY} `],
    ["a newline", `${KEY}\n`],
    ["a non-ASCII digit look-alike", `ac_live_${"a".repeat(31)}\u0661`],
  ])("rejects %s", (_label, value) => {
    expect(isWellFormedKey(value)).toBe(false);
  });
});

describe("extractBearerKey", () => {
  it.each(["Bearer", "bearer", "BEARER"])("returns the key for the scheme %s", (scheme) => {
    expect(extractBearerKey(`${scheme} ${KEY}`)).toBe(KEY);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["only the scheme", "Bearer"],
    ["the scheme and a space", "Bearer "],
    ["two tokens", `Bearer ${KEY} extra`],
    ["another scheme", `Basic ${KEY}`],
    ["no space", `Bearer${KEY}`],
    ["two spaces", `Bearer  ${KEY}`],
    ["a tab", `Bearer\t${KEY}`],
    ["leading whitespace", ` Bearer ${KEY}`],
    ["trailing whitespace", `Bearer ${KEY} `],
    ["a malformed key", "Bearer ac_live_short"],
    ["a test key", `Bearer ac_test_${"a".repeat(32)}`],
    ["the bare key with no scheme", KEY],
  ])("returns null for %s", (_label, header) => {
    expect(extractBearerKey(header)).toBeNull();
  });
});
