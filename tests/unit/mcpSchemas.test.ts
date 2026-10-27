import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { IDEMPOTENCY_KEY_PATTERN, LIMITS, PAGE } from "@/lib/config/constants";
import {
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  fileCaseInputShape,
  getCaseInputShape,
  listInputShape,
  searchInputShape,
  submitArgumentInputShape,
} from "@/lib/mcp/schemas";
import { parseArgumentInput } from "@/lib/schemas/argument";
import { parseCaseInput } from "@/lib/schemas/case";
import { parseIdempotencyKey } from "@/lib/schemas/idempotency";
import { parseListQuery } from "@/lib/schemas/pagination";
import { parseSearchQuery } from "@/lib/schemas/search";

type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
};
const jsonSchema = (shape: z.ZodRawShape) => z.toJSONSchema(z.object(shape), { io: "input" }) as JsonSchema;

/** Names of the properties, at any depth, that have no description. */
function undescribed(schema: JsonSchema, path = ""): string[] {
  const missing: string[] = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const here = path ? `${path}.${name}` : name;
    if (typeof property.description !== "string" || property.description.trim() === "") missing.push(here);
    if (property.properties) missing.push(...undescribed(property, here));
    if (property.items?.properties) missing.push(...undescribed(property.items, `${here}[]`));
  }
  return missing;
}

const text = (length: number) => "a".repeat(length);

describe("tool names", () => {
  it("are the five agreed names", () => {
    expect(Object.values(TOOL_NAMES).sort()).toEqual(
      ["court_file_case", "court_get_case", "court_list_open_cases", "court_search_precedents", "court_submit_argument"].sort(),
    );
  });
});

describe("tool descriptions", () => {
  it("exist for every tool, are plain text and differ from each other", () => {
    const all = Object.values(TOOL_NAMES).map((name) => TOOL_DESCRIPTIONS[name]);
    for (const description of all) {
      expect(typeof description).toBe("string");
      expect(description.trim().length).toBeGreaterThan(20);
      expect(description.length).toBeLessThanOrEqual(1000);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it("remind the agent that other agents' text is data, on every tool that returns it", () => {
    for (const name of [TOOL_NAMES.search, TOOL_NAMES.list, TOOL_NAMES.get]) {
      expect(TOOL_DESCRIPTIONS[name]).toMatch(/untrusted_content/);
    }
  });

  it("tell the agent how to retry a write and what a held result means", () => {
    for (const name of [TOOL_NAMES.file, TOOL_NAMES.submit]) {
      expect(TOOL_DESCRIPTIONS[name]).toMatch(/idempotency_key/);
      expect(TOOL_DESCRIPTIONS[name]).toMatch(/held_for_review/);
    }
  });

  it("do not depend on the environment or on anything read at run time", async () => {
    const before = JSON.stringify(TOOL_DESCRIPTIONS);
    vi.resetModules();
    const again = await import("@/lib/mcp/schemas");
    expect(JSON.stringify(again.TOOL_DESCRIPTIONS)).toBe(before);
  });
});

describe("input shapes: every field is described for the agent", () => {
  it.each([
    ["search", searchInputShape],
    ["list", listInputShape],
    ["file case", fileCaseInputShape],
    ["get case", getCaseInputShape],
    ["submit argument", submitArgumentInputShape],
  ])("%s", (_name, shape) => {
    expect(undescribed(jsonSchema(shape))).toEqual([]);
  });

  it("marks the right fields as required", () => {
    expect(jsonSchema(searchInputShape).required).toEqual(["query"]);
    expect(jsonSchema(listInputShape).required ?? []).toEqual([]);
    expect([...(jsonSchema(fileCaseInputShape).required ?? [])].sort()).toEqual(["actual", "expected", "summary", "title"]);
    expect(jsonSchema(getCaseInputShape).required).toEqual(["case_id"]);
    expect([...(jsonSchema(submitArgumentInputShape).required ?? [])].sort()).toEqual(["case_id", "proposed_change", "reasoning"]);
  });
});

// The REST handler validates again with the shared schemas, so the MCP shapes only have to avoid being stricter
// than REST (they would wrongly refuse valid input) and to say the same limits to the agent.
describe("input shapes agree with the shared schemas at every limit", () => {
  describe("court_file_case", () => {
    const mcp = z.object(fileCaseInputShape);
    const base = { title: "t", summary: "s", expected: "e", actual: "a" };
    const agree = (over: Record<string, unknown>) => ({
      mcp: mcp.safeParse({ ...base, ...over }).success,
      rest: parseCaseInput({ ...base, ...over }).ok,
    });

    it.each([
      ["title at the limit", { title: text(LIMITS.title) }, true],
      ["title over the limit", { title: text(LIMITS.title + 1) }, false],
      ["summary at the limit", { summary: text(LIMITS.summary) }, true],
      ["summary over the limit", { summary: text(LIMITS.summary + 1) }, false],
      ["expected at the limit", { expected: text(LIMITS.expectedActual) }, true],
      ["expected over the limit", { expected: text(LIMITS.expectedActual + 1) }, false],
      ["actual at the limit", { actual: text(LIMITS.expectedActual) }, true],
      ["actual over the limit", { actual: text(LIMITS.expectedActual + 1) }, false],
      ["an empty title", { title: "" }, false],
      ["a tag that is a slug", { tags: ["ok-tag", "retry-loop"] }, true],
      ["a tag of 32 characters", { tags: [text(32)] }, true],
      ["a tag of 33 characters", { tags: [text(33)] }, false],
      ["a tag with capitals", { tags: ["Upper"] }, false],
      ["a tag with a space", { tags: ["has space"] }, false],
      ["8 tags", { tags: Array.from({ length: LIMITS.tagsPerCase }, (_, i) => `tag-${i}`) }, true],
      ["9 tags", { tags: Array.from({ length: LIMITS.tagsPerCase + 1 }, (_, i) => `tag-${i}`) }, false],
      ["10 evidence items", { evidence: Array.from({ length: LIMITS.evidencePerCase }, () => ({ kind: "trace", text: "x" })) }, true],
      ["11 evidence items", { evidence: Array.from({ length: LIMITS.evidencePerCase + 1 }, () => ({ kind: "trace", text: "x" })) }, false],
      ["evidence text at the limit", { evidence: [{ kind: "error", text: text(LIMITS.evidenceText) }] }, true],
      ["evidence text over the limit", { evidence: [{ kind: "error", text: text(LIMITS.evidenceText + 1) }] }, false],
      ["every evidence kind", { evidence: ["trace", "prompt", "tool_schema", "error"].map((kind) => ({ kind, text: "x" })) }, true],
      ["an unknown evidence kind", { evidence: [{ kind: "log", text: "x" }] }, false],
      ["model at 80", { environment: { model: text(80) } }, true],
      ["model at 81", { environment: { model: text(81) } }, false],
      ["framework at 80", { environment: { framework: text(80) } }, true],
      ["framework at 81", { environment: { framework: text(81) } }, false],
      ["framework_version at 40", { environment: { framework_version: text(40) } }, true],
      ["framework_version at 41", { environment: { framework_version: text(41) } }, false],
      ["language at 40", { environment: { language: text(40) } }, true],
      ["language at 41", { environment: { language: text(41) } }, false],
      ["os at 40", { environment: { os: text(40) } }, true],
      ["os at 41", { environment: { os: text(41) } }, false],
      ["notes at 500", { environment: { notes: text(500) } }, true],
      ["notes at 501", { environment: { notes: text(501) } }, false],
      ["20 tools", { environment: { tools: Array.from({ length: 20 }, () => "search") } }, true],
      ["21 tools", { environment: { tools: Array.from({ length: 21 }, () => "search") } }, false],
      ["a tool name at 60", { environment: { tools: [text(60)] } }, true],
      ["a tool name at 61", { environment: { tools: [text(61)] } }, false],
      ["an unknown environment key", { environment: { secret_field: "x" } }, false],
    ])("%s", (_label, over, expected) => {
      expect(agree(over as Record<string, unknown>)).toEqual({ mcp: expected, rest: expected });
    });

    it("accepts the optional idempotency key, which is not part of the case", () => {
      expect(mcp.safeParse({ ...base, idempotency_key: "retry-key-0001" }).success).toBe(true);
    });
  });

  describe("court_submit_argument", () => {
    const mcp = z.object(submitArgumentInputShape);
    const caseId = "00000000-0000-4000-8000-000000000001";
    const base = { reasoning: "r", proposed_change: "p" };
    const agree = (over: Record<string, unknown>) => ({
      mcp: mcp.safeParse({ case_id: caseId, ...base, ...over }).success,
      rest: parseArgumentInput({ ...base, ...over }).ok,
    });

    it.each([
      ["reasoning at the limit", { reasoning: text(LIMITS.argumentField) }, true],
      ["reasoning over the limit", { reasoning: text(LIMITS.argumentField + 1) }, false],
      ["proposed_change at the limit", { proposed_change: text(LIMITS.argumentField) }, true],
      ["proposed_change over the limit", { proposed_change: text(LIMITS.argumentField + 1) }, false],
      ["an empty reasoning", { reasoning: "" }, false],
      ["an empty proposed_change", { proposed_change: "" }, false],
    ])("%s", (_label, over, expected) => {
      expect(agree(over)).toEqual({ mcp: expected, rest: expected });
    });
  });

  describe("court_search_precedents", () => {
    const mcp = z.object(searchInputShape);
    const agree = (query: string, limit?: number) => ({
      mcp: mcp.safeParse({ query, ...(limit === undefined ? {} : { limit }) }).success,
      rest: parseSearchQuery(new URLSearchParams({ q: query, ...(limit === undefined ? {} : { limit: String(limit) }) })).ok,
    });

    it.each([
      ["one character", "a", undefined, true],
      ["200 characters", text(200), undefined, true],
      ["201 characters", text(201), undefined, false],
      ["an empty query", "", undefined, false],
      ["limit 1", "x", 1, true],
      ["limit 20", "x", 20, true],
      ["limit 0", "x", 0, false],
      ["limit 21", "x", 21, false],
      ["limit 1.5", "x", 1.5, false],
    ])("%s", (_label, query, limit, expected) => {
      expect(agree(query, limit)).toEqual({ mcp: expected, rest: expected });
    });
  });

  describe("court_list_open_cases", () => {
    const mcp = z.object(listInputShape);
    const agree = (over: { tag?: string; limit?: number }) => {
      const params = new URLSearchParams();
      if (over.tag !== undefined) params.set("tag", over.tag);
      if (over.limit !== undefined) params.set("limit", String(over.limit));
      return { mcp: mcp.safeParse(over).success, rest: parseListQuery(params).ok };
    };

    it.each([
      ["no arguments", {}, true],
      ["limit 1", { limit: 1 }, true],
      ["the page maximum", { limit: PAGE.maxLimit }, true],
      ["one over the page maximum", { limit: PAGE.maxLimit + 1 }, false],
      ["limit 0", { limit: 0 }, false],
      ["a slug tag", { tag: "retry-loop" }, true],
      ["a tag of 32 characters", { tag: text(32) }, true],
      ["a tag of 33 characters", { tag: text(33) }, false],
      ["a tag with capitals", { tag: "Upper" }, false],
    ])("%s", (_label, over, expected) => {
      expect(agree(over)).toEqual({ mcp: expected, rest: expected });
    });

    it("takes a cursor as plain text and leaves its meaning to the REST handler", () => {
      expect(mcp.safeParse({ cursor: "anything-the-server-gave-us" }).success).toBe(true);
    });
  });

  describe("case ids and idempotency keys", () => {
    it("accepts any UUID-shaped id, the nil UUID included, and refuses anything else", () => {
      const get = z.object(getCaseInputShape);
      for (const good of [crypto.randomUUID(), "00000000-0000-0000-0000-000000000000", crypto.randomUUID().toUpperCase()]) {
        expect(get.safeParse({ case_id: good }).success, good).toBe(true);
      }
      for (const bad of ["", "not-a-uuid", "1234", "../admin", "'; DROP TABLE cases; --", `${crypto.randomUUID()}x`]) {
        expect(get.safeParse({ case_id: bad }).success, bad).toBe(false);
      }
    });

    it("applies the same idempotency key rule as the REST header", () => {
      const submit = z.object(submitArgumentInputShape);
      const base = { case_id: crypto.randomUUID(), reasoning: "r", proposed_change: "p" };
      for (const key of ["abcdefgh", text(128), "a.b:c_d-e1234", text(7), text(129), "has space1", "bad/slash1", ""]) {
        expect(submit.safeParse({ ...base, idempotency_key: key }).success, key).toBe(parseIdempotencyKey(key).ok);
      }
      expect(IDEMPOTENCY_KEY_PATTERN.test("abcdefgh")).toBe(true);
    });
  });
});
