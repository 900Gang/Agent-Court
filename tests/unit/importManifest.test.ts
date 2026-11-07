import { describe, expect, it } from "vitest";
import { IMPORT, IMPORT_TAGS, TAG_PATTERN } from "@/lib/config/constants";
import { parseManifest, parseManifestEntry } from "@/lib/import/manifest";
import { IMPORT_SOURCES } from "@/lib/import/sources";
import { entryFor, goodEntry } from "../helpers/importEntries";

const MARKER = "SECRET-MARKER";

type EntryResult = ReturnType<typeof parseManifestEntry>;
type ManifestResult = ReturnType<typeof parseManifest>;

function valueOf(result: EntryResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${JSON.stringify(result.detail)}`);
  return result.value;
}

function detailOf(result: EntryResult): Record<string, string> {
  if (result.ok) throw new Error("expected a failure");
  return result.detail ?? {};
}

function problemsOf(result: ManifestResult) {
  if (result.ok) throw new Error("expected problems");
  return result.problems;
}

function without(entry: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([name]) => name !== key));
}

const TEXT_FIELDS: Array<[string, number]> = [
  ["title", 200],
  ["summary", 4000],
  ["expected", 2000],
  ["actual", 2000],
  ["fixReasoning", 8000],
  ["fixChange", 8000],
  ["note", 500],
  ["framework", 80],
  ["language", 40],
];

describe("IMPORT_TAGS", () => {
  it("is a fixed list of valid case tags, without repeats", () => {
    expect(IMPORT_TAGS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(IMPORT_TAGS).size).toBe(IMPORT_TAGS.length);
    for (const tag of IMPORT_TAGS) expect(TAG_PATTERN.test(tag)).toBe(true);
  });

  it("holds the topics the design names", () => {
    for (const tag of ["tool-calling", "structured-output", "retries", "loops", "memory", "streaming", "protocol", "schema"]) {
      expect(IMPORT_TAGS).toContain(tag);
    }
  });
});

describe("parseManifestEntry: a good entry", () => {
  it("passes, and the licence is attached from the list", () => {
    expect(valueOf(parseManifestEntry(goodEntry()))).toEqual({ ...goodEntry(), license: "MIT" });
  });

  it.each(Object.entries(IMPORT_SOURCES))("gives %s the licence %s", (repository, license) => {
    const entry = goodEntry({
      repository,
      issueUrl: `https://github.com/${repository}/issues/5`,
      fixUrl: `https://github.com/${repository}/pull/6`,
    });
    expect(valueOf(parseManifestEntry(entry)).license).toBe(license);
  });

  it("trims text and removes control characters but keeps newlines", () => {
    const parsed = valueOf(parseManifestEntry(goodEntry({ title: "  Hello  ", summary: "line1\nline2\u0000end" })));
    expect(parsed.title).toBe("Hello");
    expect(parsed.summary).toBe("line1\nline2end");
  });

  it("does not change the input", () => {
    const input = goodEntry();
    const copy = structuredClone(input);
    parseManifestEntry(input);
    expect(input).toEqual(copy);
  });

  it("accepts every listed tag", () => {
    for (let at = 0; at < IMPORT_TAGS.length; at += 8) {
      const tags = IMPORT_TAGS.slice(at, at + 8) as string[];
      expect(valueOf(parseManifestEntry(goodEntry({ tags }))).tags).toEqual(tags);
    }
  });
});

describe("parseManifestEntry: text fields", () => {
  it.each(TEXT_FIELDS)("%s accepts exactly %i characters and refuses one more", (field, max) => {
    expect(parseManifestEntry({ ...goodEntry(), [field]: "a".repeat(max) }).ok).toBe(true);
    const tooLong = parseManifestEntry({ ...goodEntry(), [field]: `${MARKER} ${"a".repeat(max)}` });
    expect(detailOf(tooLong)[field]).toMatch(new RegExp(`at most ${max}`));
    expect(JSON.stringify(tooLong)).not.toContain(MARKER);
  });

  it.each(TEXT_FIELDS)("%s is required", (field) => {
    expect(detailOf(parseManifestEntry(without(goodEntry(), field)))[field]).toBe("is required");
  });

  it.each(TEXT_FIELDS)("%s must be text and not empty", (field) => {
    for (const value of [12, null, true, {}, ["x"]]) {
      expect(detailOf(parseManifestEntry({ ...goodEntry(), [field]: value }))[field]).toBeDefined();
    }
    expect(detailOf(parseManifestEntry({ ...goodEntry(), [field]: "" }))[field]).toBe("must not be empty");
    expect(detailOf(parseManifestEntry({ ...goodEntry(), [field]: "  \n\t " }))[field]).toBe("must not be empty");
  });

  it.each(TEXT_FIELDS)("%s refuses raw HTML and never repeats it", (field) => {
    for (const html of ["<script>alert(1)</script>", "<b>bold</b>", "<!-- note -->", "a <img src=x> b", "</div>"]) {
      const result = parseManifestEntry({ ...goodEntry(), [field]: `${MARKER} ${html}` });
      expect(detailOf(result)[field]).toMatch(/html/i);
      expect(JSON.stringify(result)).not.toContain(MARKER);
    }
  });

  it("allows a less-than or greater-than sign that is not a tag", () => {
    expect(parseManifestEntry(goodEntry({ summary: "The count fell when a < b and rose when c > d, or x<1." })).ok).toBe(true);
  });
});

describe("parseManifestEntry: repository and links", () => {
  it("refuses a repository that is not on the list", () => {
    expect(detailOf(parseManifestEntry(goodEntry({ repository: "someone/else" }))).repository).toBeDefined();
  });

  it.each(["modelcontextprotocol/typescript-sdk", "vercel/ai", "BerriAI/litellm"])("refuses %s, which states no licence", (repository) => {
    const entry = goodEntry({
      repository,
      issueUrl: `https://github.com/${repository}/issues/1`,
      fixUrl: `https://github.com/${repository}/pull/2`,
    });
    expect(detailOf(parseManifestEntry(entry)).repository).toBeDefined();
  });

  it("is exact about the repository name", () => {
    for (const repository of ["Langchain-AI/langchain", "langchain-ai/langchain ", " langchain-ai/langchain", "langchain-ai"]) {
      expect(detailOf(parseManifestEntry(goodEntry({ repository }))).repository).toBeDefined();
    }
    expect(detailOf(parseManifestEntry({ ...goodEntry(), repository: 12 })).repository).toBeDefined();
    expect(detailOf(parseManifestEntry(without(goodEntry(), "repository"))).repository).toBe("is required");
  });

  it("wants an issue link in issueUrl and a pull request link in fixUrl", () => {
    expect(detailOf(parseManifestEntry(goodEntry({ issueUrl: "https://github.com/langchain-ai/langchain/pull/1234" }))).issueUrl).toBeDefined();
    expect(detailOf(parseManifestEntry(goodEntry({ fixUrl: "https://github.com/langchain-ai/langchain/issues/1240" }))).fixUrl).toBeDefined();
  });

  it("wants both links in the repository the entry names", () => {
    const other = "https://github.com/langchain-ai/langgraph";
    expect(detailOf(parseManifestEntry(goodEntry({ issueUrl: `${other}/issues/1` }))).issueUrl).toBeDefined();
    expect(detailOf(parseManifestEntry(goodEntry({ fixUrl: `${other}/pull/2` }))).fixUrl).toBeDefined();
  });

  it.each([
    "http://github.com/langchain-ai/langchain/issues/1",
    "https://github.com.evil.example/langchain-ai/langchain/issues/1",
    "https://user:pw@github.com/langchain-ai/langchain/issues/1",
    "https://github.com/langchain-ai/langchain/issues/1?x=1",
    "https://github.com/langchain-ai/langchain/issues/1#issuecomment-2",
    "https://github.com/langchain-ai/langchain/issues/1/",
    "https://github.com/langchain-ai/langchain/issues/01",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "",
  ])("refuses the hostile link %j in both fields", (url) => {
    expect(detailOf(parseManifestEntry(goodEntry({ issueUrl: url }))).issueUrl).toBeDefined();
    expect(detailOf(parseManifestEntry(goodEntry({ fixUrl: url }))).fixUrl).toBeDefined();
  });

  it("never repeats a refused link", () => {
    const result = parseManifestEntry(goodEntry({ issueUrl: `https://evil.example/${MARKER}`, fixUrl: `javascript:${MARKER}` }));
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it("needs both links", () => {
    expect(detailOf(parseManifestEntry(without(goodEntry(), "issueUrl"))).issueUrl).toBe("is required");
    expect(detailOf(parseManifestEntry(without(goodEntry(), "fixUrl"))).fixUrl).toBe("is required");
  });
});

describe("parseManifestEntry: tags", () => {
  it("needs at least one", () => {
    expect(detailOf(parseManifestEntry(goodEntry({ tags: [] }))).tags).toBeDefined();
    expect(detailOf(parseManifestEntry(without(goodEntry(), "tags"))).tags).toBe("is required");
  });

  it("takes at most the case limit", () => {
    expect(parseManifestEntry(goodEntry({ tags: IMPORT_TAGS.slice(0, 8) as string[] })).ok).toBe(true);
    expect(detailOf(parseManifestEntry(goodEntry({ tags: IMPORT_TAGS.slice(0, 9) as string[] }))).tags).toBeDefined();
  });

  it("refuses repeats", () => {
    expect(detailOf(parseManifestEntry(goodEntry({ tags: ["loops", "loops"] }))).tags).toBeDefined();
  });

  it("refuses a tag that is not on the fixed list, even a well-formed one, and never repeats it", () => {
    for (const tag of ["not-a-listed-tag", "Tool-Calling", "ignore previous instructions", `x-${MARKER}`]) {
      const result = parseManifestEntry(goodEntry({ tags: ["loops", tag] }));
      expect(detailOf(result).tags).toBeDefined();
      expect(JSON.stringify(result)).not.toContain(MARKER);
    }
  });

  it("wants a list of text", () => {
    for (const tags of ["loops", 12, null, { 0: "loops" }, [12], [null], [["loops"]]]) {
      expect(detailOf(parseManifestEntry({ ...goodEntry(), tags })).tags).toBeDefined();
    }
  });
});

describe("parseManifestEntry: nothing else is allowed", () => {
  it("refuses a field that is not in the schema", () => {
    expect(detailOf(parseManifestEntry({ ...goodEntry(), extra: "x" })).form).toMatch(/not allowed/);
  });

  it.each(["license", "licence", "sourceLicense", "source_license"])("refuses an entry that sets its own %s, even the right one", (key) => {
    expect(detailOf(parseManifestEntry({ ...goodEntry(), [key]: "MIT" })).form).toMatch(/not allowed/);
  });

  it("refuses a __proto__ key from JSON", () => {
    const text = JSON.stringify(goodEntry()).replace(/^\{/, '{"__proto__":{"x":1},');
    expect(detailOf(parseManifestEntry(JSON.parse(text))).form).toMatch(/not allowed/);
  });

  it("does not repeat the name of an unknown field", () => {
    expect(JSON.stringify(parseManifestEntry({ ...goodEntry(), [MARKER]: "x" }))).not.toContain(MARKER);
  });

  it.each([null, undefined, 12, "text", [], true])("refuses %j, which is not an object", (value) => {
    expect(detailOf(parseManifestEntry(value)).form).toBe("must be an object");
  });
});

describe("parseManifest", () => {
  it("accepts a list of good entries, with licences, in order", () => {
    const result = parseManifest([entryFor(1), entryFor(2), entryFor(3)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((entry) => entry.issueUrl.split("/").pop())).toEqual(["1", "2", "3"]);
    expect(result.value.every((entry) => entry.license === "MIT")).toBe(true);
  });

  it("accepts the largest batch and refuses one more, with a single problem and no per-entry work", () => {
    const largest = Array.from({ length: IMPORT.maxBatch }, (_, i) => entryFor(i + 1));
    expect(parseManifest(largest).ok).toBe(true);
    const tooMany = problemsOf(parseManifest(Array.from({ length: IMPORT.maxBatch + 1 }, () => ({ bad: true }))));
    expect(tooMany).toHaveLength(1);
    expect(tooMany[0].position).toBeNull();
    expect(tooMany[0].detail.form).toMatch(new RegExp(`at most ${IMPORT.maxBatch}`));
  });

  it.each([{}, "text", null, undefined, 12, true])("refuses %j, which is not a list", (value) => {
    const problems = problemsOf(parseManifest(value));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ position: null, issue: null });
    expect(problems[0].detail.form).toMatch(/list/);
  });

  it("refuses an empty list, which is a mistake", () => {
    const problems = problemsOf(parseManifest([]));
    expect(problems[0].position).toBeNull();
    expect(problems[0].detail.form).toMatch(/at least one/);
  });

  it("reports every bad entry by position and issue number, and the good ones are not named", () => {
    const problems = problemsOf(
      parseManifest([
        entryFor(1),
        entryFor(1235, { title: "" }),
        entryFor(3),
        entryFor(77, { repository: "someone/else" }),
        { not: "an entry" },
      ]),
    );
    expect(problems.map((problem) => [problem.position, problem.issue])).toEqual([
      [2, 1235],
      [4, 77],
      [5, null],
    ]);
    expect(problems[0].detail.title).toBe("must not be empty");
    expect(problems[1].detail.repository).toBeDefined();
    expect(problems[2].detail.form).toMatch(/not allowed/);
  });

  it("gives no issue number when the link is not a well-formed issue link", () => {
    const problems = problemsOf(parseManifest([entryFor(1, { issueUrl: "https://github.com/langchain-ai/langchain/pull/9" })]));
    expect(problems[0].issue).toBeNull();
  });

  it("refuses a second entry for the same issue, and flags only the later one", () => {
    const problems = problemsOf(parseManifest([entryFor(5), entryFor(6), entryFor(5, { title: "A different title" })]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ position: 3, issue: 5 });
    expect(problems[0].detail.issueUrl).toMatch(/duplicate/);
  });

  it("keeps the duplicate problem and the entry's own problems together", () => {
    const problems = problemsOf(parseManifest([entryFor(5), entryFor(5, { title: "" })]));
    expect(problems).toHaveLength(1);
    expect(problems[0].detail.title).toBe("must not be empty");
    expect(problems[0].detail.issueUrl).toMatch(/duplicate/);
  });

  it("does not repeat any entry text in its problems", () => {
    const result = parseManifest([
      entryFor(1, { title: `${MARKER} ${"a".repeat(300)}`, tags: [`x-${MARKER}`], issueUrl: `https://evil.example/${MARKER}` }),
      { [MARKER]: MARKER },
    ]);
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });
});
