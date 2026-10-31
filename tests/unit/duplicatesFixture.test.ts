import { describe, expect, it } from "vitest";
import { createGate } from "@/lib/safety/engine";
import { caseGateFields } from "@/lib/safety/fields";
import { prepareQuery } from "@/lib/search/query";
import { parseCaseInput } from "@/lib/schemas/case";
import { parseSearchQuery } from "@/lib/schemas/search";
import { loadDuplicates } from "../helpers/duplicates";

const fixture = loadDuplicates();
const STOP = new Set("the and for with that this from into than then when after before over under are was were has have had not but you your its their they them what which will would could should about also only just more most some any all can may".split(" "));

const words = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length >= 3 && !STOP.has(word)));
const caseText = (c: (typeof fixture.cases)[number]) => [c.title, c.summary, c.expected, c.actual, c.tags.join(" ")].join(" ");

describe("the duplicate-recall fixture: its shape", () => {
  it("has 100 cases, half of them originals and half distractors, and 50 queries", () => {
    expect(fixture.cases).toHaveLength(100);
    expect(fixture.cases.filter((c) => c.id.startsWith("c"))).toHaveLength(50);
    expect(fixture.cases.filter((c) => c.id.startsWith("d"))).toHaveLength(50);
    expect(fixture.queries).toHaveLength(50);
  });

  it("has unique ids and unique titles", () => {
    expect(new Set(fixture.cases.map((c) => c.id)).size).toBe(100);
    expect(new Set(fixture.cases.map((c) => c.title.toLowerCase())).size).toBe(100);
    expect(new Set(fixture.queries.map((query) => query.id)).size).toBe(50);
  });

  it("gives every query exactly one original, and every original exactly one query", () => {
    const originals = new Set(fixture.cases.filter((c) => c.id.startsWith("c")).map((c) => c.id));
    const truths = fixture.queries.map((query) => query.truth);
    for (const truth of truths) expect(originals.has(truth), truth).toBe(true);
    expect(new Set(truths).size).toBe(50);
  });

  it("is made of cases the API would accept", () => {
    for (const c of fixture.cases) {
      const parsed = parseCaseInput({ title: c.title, summary: c.summary, expected: c.expected, actual: c.actual, tags: c.tags, environment: {}, evidence: [] });
      expect(parsed.ok, c.id).toBe(true);
    }
  });

  it("has queries the search API would accept", () => {
    for (const query of fixture.queries) {
      const parsed = parseSearchQuery(new URLSearchParams({ q: query.text }));
      expect(parsed.ok, query.id).toBe(true);
      expect(query.text.length, query.id).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("the duplicate-recall fixture: what it tests", () => {
  const originalOf = (truth: string) => fixture.cases.find((c) => c.id === truth) as (typeof fixture.cases)[number];

  it("has queries that are a rewording, not a copy: at most half of a query's words are in its original", () => {
    for (const query of fixture.queries) {
      const original = words(caseText(originalOf(query.truth)));
      const own = [...words(query.text)];
      const shared = own.filter((word) => original.has(word)).length;
      expect(shared / own.length, `${query.id}: ${[...own].filter((word) => original.has(word)).join(", ")}`).toBeLessThanOrEqual(0.5);
    }
  });

  it("never has a query that is the title or the summary of its original", () => {
    for (const query of fixture.queries) {
      const original = originalOf(query.truth);
      expect(query.text.toLowerCase()).not.toBe(original.title.toLowerCase());
      expect(original.summary.toLowerCase()).not.toContain(query.text.toLowerCase());
    }
  });

  it("has distractors that are about other things: no query shares more than half of its words with any distractor", () => {
    const distractors = fixture.cases.filter((c) => c.id.startsWith("d")).map((c) => words(caseText(c)));
    for (const query of fixture.queries) {
      const own = [...words(query.text)];
      for (const distractor of distractors) {
        expect(own.filter((word) => distractor.has(word)).length / own.length, query.id).toBeLessThanOrEqual(0.5);
      }
    }
  });
});

describe("the duplicate-recall fixture: the gate lets all of it through untouched", () => {
  it("passes every case, with nothing redacted or changed", async () => {
    const gate = createGate();
    for (const c of fixture.cases) {
      const parsed = parseCaseInput({ title: c.title, summary: c.summary, expected: c.expected, actual: c.actual, tags: c.tags, environment: {}, evidence: [] });
      if (!parsed.ok) throw new Error(c.id);
      const input = caseGateFields(parsed.value);
      const decision = await gate.screen({ target: "case", fields: input });
      expect(decision.outcome, c.id).toBe("pass");
      expect(decision.fields, c.id).toEqual(input);
    }
  });

  it("passes every query as a search query and as plain text, with nothing redacted or changed", async () => {
    const gate = createGate();
    for (const query of fixture.queries) {
      expect(prepareQuery(query.text), query.id).toEqual({ text: query.text, redactions: 0, searchable: true });
      const decision = await gate.screen({ target: "report", fields: { reason: query.text } });
      expect(decision.outcome, query.id).toBe("pass");
      expect(decision.fields.reason, query.id).toBe(query.text);
    }
  });
});
