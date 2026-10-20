import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_TTL_HOURS,
  LIMITS,
  PAGE,
  PUBLIC_CASE_STATUSES,
  TAG_PATTERN,
} from "@/lib/config/constants";

describe("content limits", () => {
  it("has the agreed sizes", () => {
    expect(LIMITS).toEqual({
      title: 200,
      summary: 4000,
      expectedActual: 2000,
      evidenceText: 32000,
      evidencePerCase: 10,
      argumentField: 8000,
      argumentsPerCase: 20,
      tagsPerCase: 8,
      environmentBytes: 4096,
      bodyBytes: 262144,
    });
  });
});

describe("tags", () => {
  it.each(["tool-call", "a", "gpt-4", "a".repeat(32)])("accepts %s", (tag) => {
    expect(TAG_PATTERN.test(tag)).toBe(true);
  });

  it.each(["Fix It", "fix the bug", "Upper", "a".repeat(33), "", "under_score", "emoji-🙂"])(
    "rejects %j",
    (tag) => {
      expect(TAG_PATTERN.test(tag)).toBe(false);
    },
  );
});

describe("pagination", () => {
  it("defaults to 20 and stops at 50", () => {
    expect(PAGE).toEqual({ defaultLimit: 20, maxLimit: 50 });
  });
});

describe("public case statuses", () => {
  it("lists the five statuses any agent may read", () => {
    expect([...PUBLIC_CASE_STATUSES]).toEqual(["open", "argued", "resolved", "under_appeal", "closed_unresolved"]);
  });

  it.each(["held", "withdrawn", "rejected"])("does not include %s", (status) => {
    expect(PUBLIC_CASE_STATUSES as readonly string[]).not.toContain(status);
  });
});

describe("idempotency", () => {
  it("keeps keys for 24 hours", () => {
    expect(IDEMPOTENCY_TTL_HOURS).toBe(24);
  });

  it.each(["abcdefgh", "a".repeat(128), "req_2026-10-20:retry.1"])("accepts %s", (key) => {
    expect(IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(true);
  });

  it.each(["short", "a".repeat(129), "has space here", "semi;colon!", "", "new\nline123"])(
    "rejects %j",
    (key) => {
      expect(IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(false);
    },
  );
});
