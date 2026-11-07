import { describe, expect, it } from "vitest";
import { IMPORT } from "@/lib/config/constants";
import { guardParaphrase, longestSharedRun } from "@/lib/import/guard";
import { goodEntry } from "../helpers/importEntries";

const words = (count: number, prefix = "w") => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

describe("longestSharedRun", () => {
  it("counts the words of an identical text", () => {
    expect(longestSharedRun(words(9).join(" "), words(9).join(" "))).toBe(9);
  });

  it("ignores case", () => {
    expect(longestSharedRun("The Agent KEPT calling", "the agent kept CALLING")).toBe(4);
  });

  it("ignores punctuation and markdown marks", () => {
    expect(longestSharedRun("Hello, WORLD! `foo` **bar**", "hello world foo bar")).toBe(4);
    expect(longestSharedRun("a - b; c: d (e) [f] {g}", "a b c d e f g")).toBe(7);
  });

  it("does not split a word at an apostrophe", () => {
    expect(longestSharedRun("don't stop", "dont stop")).toBe(2);
    expect(longestSharedRun("don’t stop", "dont stop")).toBe(2);
  });

  it("ignores spaces, tabs and line breaks", () => {
    expect(longestSharedRun("a b\n c\t\td\r\n e", "a  b c d e")).toBe(5);
  });

  it("counts numbers and letters with accents as words", () => {
    expect(longestSharedRun("version 3 of café naïve", "VERSION 3 of CAFÉ NAÏVE")).toBe(5);
  });

  it("wants the words in the same order", () => {
    expect(longestSharedRun("a b c", "c b a")).toBe(1);
  });

  it("is broken by one changed word", () => {
    const original = words(19);
    const changed = [...original];
    changed[9] = "different";
    expect(longestSharedRun(original.join(" "), changed.join(" "))).toBe(9);
  });

  it("answers the longest run, not the first", () => {
    expect(longestSharedRun("x y z a b c d", "a b c d x y")).toBe(4);
  });

  it("handles repeated words", () => {
    expect(longestSharedRun("a a a a a", "a a a")).toBe(3);
  });

  it("is symmetric", () => {
    const a = "the loop check compared the new call only with the last message";
    const b = "a new call only with the last message was compared by the loop";
    expect(longestSharedRun(a, b)).toBe(longestSharedRun(b, a));
  });

  it("gives zero for empty text and for no common word", () => {
    expect(longestSharedRun("", "a b c")).toBe(0);
    expect(longestSharedRun("a b c", "")).toBe(0);
    expect(longestSharedRun("   ", "...")).toBe(0);
    expect(longestSharedRun("alpha beta", "gamma delta")).toBe(0);
  });

  it("gives a small number for unrelated sentences", () => {
    expect(
      longestSharedRun("The agent kept calling the search tool until it hit the step limit.", "Configuration files are read once when the process starts."),
    ).toBeLessThan(3);
  });

  it("refuses what is not text", () => {
    expect(() => longestSharedRun(1 as unknown as string, "a")).toThrow();
    expect(() => longestSharedRun("a", null as unknown as string)).toThrow();
  });

  it("finishes quickly on a long source", () => {
    const source = words(20000, "s").join(" ");
    const field = words(3000, "f").join(" ");
    const started = Date.now();
    expect(longestSharedRun(source, field)).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);
});

describe("guardParaphrase", () => {
  const RUN = IMPORT.paraphraseRun;
  const copy = (count: number) => words(count, "copied").join(" ");

  it("is ten words in the design", () => {
    expect(RUN).toBe(10);
  });

  it("passes an entry that shares nothing with the source", () => {
    expect(guardParaphrase(goodEntry(), "Completely different words appear in this unrelated issue body about configuration files.")).toEqual({ ok: true });
  });

  it("passes with an empty source", () => {
    expect(guardParaphrase(goodEntry(), "")).toEqual({ ok: true });
  });

  it("passes a run one word short of the limit and fails at the limit", () => {
    expect(guardParaphrase(goodEntry({ summary: `${copy(RUN - 1)} and then more` }), copy(RUN - 1))).toEqual({ ok: true });
    expect(guardParaphrase(goodEntry({ summary: `${copy(RUN)} and then more` }), copy(RUN))).toEqual({ ok: false, fields: ["summary"] });
  });

  it("is not fooled by case, punctuation, markdown or line breaks", () => {
    const source = `Intro text.\n\n${copy(RUN).toUpperCase()}\n\nOutro.`;
    const disguised = copy(RUN).split(" ").join(",\n **");
    expect(guardParaphrase(goodEntry({ fixChange: `${disguised} done` }), source)).toEqual({ ok: false, fields: ["fixChange"] });
  });

  it("finds a run that crosses a line break in the source", () => {
    const source = `${copy(5)}\n${words(5, "copied").map((_, i) => `copied${i + 5}`).join(" ")}`;
    expect(guardParaphrase(goodEntry({ title: copy(RUN) }), source)).toEqual({ ok: false, fields: ["title"] });
  });

  it("names every field that copies, in the order of the entry", () => {
    const entry = goodEntry({ note: copy(RUN), title: copy(RUN), fixReasoning: copy(RUN), actual: copy(RUN) });
    expect(guardParaphrase(entry, copy(RUN))).toEqual({ ok: false, fields: ["title", "actual", "fixReasoning", "note"] });
  });

  it("does not join the end of one field to the start of the next", () => {
    const source = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const entry = goodEntry({ title: "alpha bravo charlie delta echo", summary: "foxtrot golf hotel india juliet" });
    expect(guardParaphrase(entry, source)).toEqual({ ok: true });
  });

  it("checks each text field", () => {
    for (const field of ["title", "summary", "expected", "actual", "fixReasoning", "fixChange", "note"] as const) {
      expect(guardParaphrase(goodEntry({ [field]: copy(RUN) }), copy(RUN))).toEqual({ ok: false, fields: [field] });
    }
  });

  it("answers with field names only, never text", () => {
    const result = guardParaphrase(goodEntry({ summary: copy(RUN) }), copy(RUN));
    expect(JSON.stringify(result)).not.toContain("copied");
  });

  it("refuses a source that is not text, so a missing source is never read as a pass", () => {
    expect(() => guardParaphrase(goodEntry(), undefined as unknown as string)).toThrow();
    expect(() => guardParaphrase(goodEntry(), null as unknown as string)).toThrow();
  });
});
