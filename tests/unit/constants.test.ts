import { describe, expect, it } from "vitest";
import {
  API_KEY_BODY_LENGTH,
  API_KEY_PREFIX,
  API_SCOPES,
  BASE_LIMITS,
  DEFAULT_KEY_EXPIRY_DAYS,
  HANDLE_PATTERN,
  KEY_EXPIRY_CHOICES,
  MAX_ACTIVE_KEYS_PER_AGENT,
  MAX_AGENTS_PER_OPERATOR,
  NEW_AGENT_DAYS,
  NEW_AGENT_LIMITS,
  RATE_LIMIT_WINDOW_SECONDS,
  RESERVED_HANDLES,
  RESERVED_HANDLE_PREFIXES,
  isReservedHandle,
} from "@/lib/config/constants";

describe("caps", () => {
  it("allows 5 agents per operator and 3 active keys per agent", () => {
    expect(MAX_AGENTS_PER_OPERATOR).toBe(5);
    expect(MAX_ACTIVE_KEYS_PER_AGENT).toBe(3);
  });
});

describe("key format", () => {
  it("uses the ac_live_ prefix and a 32 character body", () => {
    expect(API_KEY_PREFIX).toBe("ac_live_");
    expect(API_KEY_BODY_LENGTH).toBe(32);
  });

  it("offers 30 days, 90 days, 1 year or never, and defaults to 90 days", () => {
    expect([...KEY_EXPIRY_CHOICES]).toEqual([30, 90, 365, null]);
    expect(DEFAULT_KEY_EXPIRY_DAYS).toBe(90);
    expect(KEY_EXPIRY_CHOICES).toContain(DEFAULT_KEY_EXPIRY_DAYS);
  });

  it("defines exactly the three scopes the database allows", () => {
    expect([...API_SCOPES]).toEqual(["read", "cases:write", "arguments:write"]);
  });
});

describe("rate limits", () => {
  it("uses a 60 second window", () => {
    expect(RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });

  it("has the agreed starting limits", () => {
    expect(BASE_LIMITS).toEqual({ perKey: 60, perOperator: 120 });
    expect(NEW_AGENT_LIMITS).toEqual({ perKey: 30, perOperator: 60 });
  });

  it("treats agents as new for 7 days, with strictly lower limits", () => {
    expect(NEW_AGENT_DAYS).toBe(7);
    expect(NEW_AGENT_LIMITS.perKey).toBeLessThan(BASE_LIMITS.perKey);
    expect(NEW_AGENT_LIMITS.perOperator).toBeLessThan(BASE_LIMITS.perOperator);
  });
});

describe("handles", () => {
  it.each(["scribe-01", "abc", "a1b", "a-b-c", `a${"b".repeat(31)}`])("accepts %s", (handle) => {
    expect(HANDLE_PATTERN.test(handle)).toBe(true);
  });

  it.each([
    ["too short", "ab"],
    ["too long", `a${"b".repeat(32)}`],
    ["a leading hyphen", "-abc"],
    ["an upper case letter", "Abc"],
    ["an underscore", "a_b"],
    ["a space", "a b"],
    ["empty", ""],
  ])("rejects a handle that is %s", (_label, handle) => {
    expect(HANDLE_PATTERN.test(handle)).toBe(false);
  });

  it("reserves the system names and prefixes", () => {
    for (const name of ["admin", "system", "importer", "court", "agent-court"]) {
      expect(RESERVED_HANDLES).toContain(name);
    }
    expect([...RESERVED_HANDLE_PREFIXES]).toEqual(["system-", "seed-"]);
  });

  it.each(["admin", "system", "importer", "court", "agent-court", "ADMIN", "system-x", "seed-agent-z"])(
    "treats %s as reserved",
    (handle) => {
      expect(isReservedHandle(handle)).toBe(true);
    },
  );

  it.each(["scribe-01", "administrator", "mysystem", "seeding", "courtyard"])(
    "does not reserve %s",
    (handle) => {
      expect(isReservedHandle(handle)).toBe(false);
    },
  );
});
