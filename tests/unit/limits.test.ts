import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/config/constants";
import type { GateContext } from "@/lib/safety/gate";
import { describeField } from "@/lib/safety/limits";
import {
  INJECTION_BLOCK_SCORE,
  INJECTION_FLAG_SCORE,
  PROMPT_EVIDENCE_WEIGHT,
  REDACTION_BLOCK_RATIO,
} from "@/lib/safety/thresholds";

describe("describeField: case fields", () => {
  it.each([
    ["title", LIMITS.title, "prose"],
    ["summary", LIMITS.summary, "prose"],
    ["expected", LIMITS.expectedActual, "prose"],
    ["actual", LIMITS.expectedActual, "prose"],
    ["environment.model", 80, "short"],
    ["environment.framework", 80, "short"],
    ["environment.framework_version", 40, "short"],
    ["environment.language", 40, "short"],
    ["environment.os", 40, "short"],
    ["environment.tools.0", 60, "short"],
    ["environment.tools.19", 60, "short"],
    ["environment.notes", 500, "prose"],
    ["tag.0", 32, "tag"],
    ["tag.7", 32, "tag"],
  ])("%s has a limit of %i and kind %s", (name, limit, kind) => {
    expect(describeField("case", name)).toEqual({ limit, kind });
  });
});

describe("describeField: evidence and argument fields", () => {
  it.each([
    ["prompt", "evidence_prompt"],
    ["trace", "evidence_trace"],
    ["tool_schema", "evidence_other"],
    ["error", "evidence_other"],
  ] as const)("evidence of kind %s is %s with a limit of 32,000", (evidenceKind, kind) => {
    expect(describeField("evidence", "text", { evidenceKind })).toEqual({ limit: LIMITS.evidenceText, kind });
  });

  it("treats evidence without a context as evidence_other", () => {
    expect(describeField("evidence", "text")).toEqual({ limit: 32000, kind: "evidence_other" });
    expect(describeField("evidence", "text", {} as GateContext)).toEqual({ limit: 32000, kind: "evidence_other" });
  });

  it.each(["reasoning", "proposed_change"])("argument %s has a limit of 8,000 and is prose", (name) => {
    expect(describeField("argument", name)).toEqual({ limit: LIMITS.argumentField, kind: "prose" });
  });
});

describe("describeField: unknown fields", () => {
  it.each([
    ["case", "bogus"],
    ["case", ""],
    ["case", "environment.bogus"],
    ["case", "environment.tools"],
    ["case", "environment.tools.20"],
    ["case", "tag"],
    ["case", "tag.8"],
    ["case", "tag.-1"],
    ["case", "tag.x"],
    ["evidence", "title"],
    ["argument", "title"],
    ["argument", "text"],
    ["profile", "handle"],
    ["profile", "text"],
    ["profile", "title"],
    ["profile", "environment.model"],
    ["profile", ""],
  ])("throws for %s / %j", (target, name) => {
    expect(() => describeField(target as never, name)).toThrow("unknown gate field");
  });

  it("never puts the field name in the error", () => {
    try {
      describeField("case", "SECRET_FIELD_NAME_123");
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).toBe("unknown gate field");
    }
  });
});

describe("thresholds", () => {
  it("holds the agreed numbers", () => {
    expect(INJECTION_FLAG_SCORE).toBe(3);
    expect(INJECTION_BLOCK_SCORE).toBe(9);
    expect(REDACTION_BLOCK_RATIO).toBe(0.5);
    expect(PROMPT_EVIDENCE_WEIGHT).toBe(0.5);
  });
});

describe("describeField: profile fields", () => {
  it.each([
    ["description", 500, "prose"],
    ["model", 80, "short"],
    ["framework", 80, "short"],
  ])("%s has a limit of %i and kind %s", (name, limit, kind) => {
    expect(describeField("profile", name)).toEqual({ limit, kind });
  });
});
