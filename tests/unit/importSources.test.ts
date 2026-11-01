import { describe, expect, it } from "vitest";
import { IMPORT } from "@/lib/config/constants";
import { IMPORT_SOURCES, licenseOf, parseGithubUrl, sameRepository } from "@/lib/import/sources";

const ELEVEN: Record<string, string> = {
  "langchain-ai/langchain": "MIT",
  "langchain-ai/langgraph": "MIT",
  "run-llama/llama_index": "MIT",
  "microsoft/autogen": "CC-BY-4.0",
  "crewAIInc/crewAI": "MIT",
  "openai/openai-agents-python": "MIT",
  "microsoft/semantic-kernel": "MIT",
  "deepset-ai/haystack": "Apache-2.0",
  "huggingface/smolagents": "Apache-2.0",
  "modelcontextprotocol/python-sdk": "MIT",
  "pydantic/pydantic-ai": "MIT",
};

describe("IMPORT", () => {
  it("holds the numbers and names in one place", () => {
    expect(IMPORT).toEqual({
      handle: "importer",
      operatorGithubId: "system:importer",
      operatorName: "Agent-Court import",
      maxBatch: 50,
      paraphraseRun: 10,
      perRepositoryShare: 0.25,
    });
  });
});

describe("IMPORT_SOURCES", () => {
  it("is exactly the eleven repositories with their licences", () => {
    expect({ ...IMPORT_SOURCES }).toEqual(ELEVEN);
  });

  it("cannot be changed while the program runs", () => {
    expect(Object.isFrozen(IMPORT_SOURCES)).toBe(true);
  });

  it("holds only licences that allow a paraphrase with attribution", () => {
    for (const licence of Object.values(IMPORT_SOURCES)) expect(["MIT", "Apache-2.0", "CC-BY-4.0"]).toContain(licence);
  });
});

describe("licenseOf", () => {
  it.each(Object.entries(ELEVEN))("gives %s its licence %s", (repository, licence) => {
    expect(licenseOf(repository)).toBe(licence);
  });

  it.each(["modelcontextprotocol/typescript-sdk", "vercel/ai", "BerriAI/litellm"])("does not know %s, which states no licence", (repository) => {
    expect(licenseOf(repository)).toBeNull();
  });

  it.each([
    "Langchain-AI/LangChain",
    "langchain-ai/langchain ",
    " langchain-ai/langchain",
    "langchain-ai/langchain\n",
    "langchain-ai",
    "langchain-ai/langchain/issues/1",
    "https://github.com/langchain-ai/langchain",
    "",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
  ])("is exact: %j is not a source", (repository) => {
    expect(licenseOf(repository)).toBeNull();
  });

  it.each([null, undefined, 12, {}, ["langchain-ai/langchain"]])("is null for the non-text %j", (value) => {
    expect(licenseOf(value as string)).toBeNull();
  });
});

describe("parseGithubUrl", () => {
  it("reads an issue link", () => {
    expect(parseGithubUrl("https://github.com/langchain-ai/langchain/issues/123")).toEqual({ owner: "langchain-ai", repo: "langchain", kind: "issue", number: 123 });
  });

  it("reads a pull request link", () => {
    expect(parseGithubUrl("https://github.com/run-llama/llama_index/pull/4567")).toEqual({ owner: "run-llama", repo: "llama_index", kind: "pull", number: 4567 });
  });

  it("allows dots, underscores and hyphens in names, and the largest number it accepts", () => {
    expect(parseGithubUrl("https://github.com/a.b_c-d/e.f_g-h/issues/999999999")).toEqual({ owner: "a.b_c-d", repo: "e.f_g-h", kind: "issue", number: 999999999 });
  });

  it.each([
    ["plain http", "http://github.com/o/r/issues/1"],
    ["an upper case scheme", "HTTPS://github.com/o/r/issues/1"],
    ["a look-alike host", "https://github.com.evil.example/o/r/issues/1"],
    ["a prefixed host", "https://evilgithub.com/o/r/issues/1"],
    ["gist", "https://gist.github.com/o/r/issues/1"],
    ["www", "https://www.github.com/o/r/issues/1"],
    ["credentials", "https://user:pw@github.com/o/r/issues/1"],
    ["a port", "https://github.com:8080/o/r/issues/1"],
    ["a query", "https://github.com/o/r/issues/1?x=1"],
    ["a fragment", "https://github.com/o/r/issues/1#issuecomment-2"],
    ["a trailing slash", "https://github.com/o/r/issues/1/"],
    ["a trailing segment", "https://github.com/o/r/pull/1/files"],
    ["a dot-dot after the number", "https://github.com/o/r/issues/1/../2"],
    ["a dot-dot owner", "https://github.com/../r/issues/1"],
    ["a dot-dot repository", "https://github.com/o/../issues/1"],
    ["a dot owner", "https://github.com/./r/issues/1"],
    ["a dot repository", "https://github.com/o/./issues/1"],
    ["an encoded slash", "https://github.com/o%2Fx/r/issues/1"],
    ["an encoded number", "https://github.com/o/r/issues/%31"],
    ["a space", "https://github.com/o/r/issues/1 "],
    ["a leading space", " https://github.com/o/r/issues/1"],
    ["a newline", "https://github.com/o/r/issues/1\n"],
    ["a tab inside", "https://github.com/o/r/is\tsues/1"],
    ["zero", "https://github.com/o/r/issues/0"],
    ["a negative number", "https://github.com/o/r/issues/-1"],
    ["a leading zero", "https://github.com/o/r/issues/01"],
    ["ten digits", "https://github.com/o/r/issues/1234567890"],
    ["an exponent", "https://github.com/o/r/issues/1e3"],
    ["a fraction", "https://github.com/o/r/issues/1.5"],
    ["a hex number", "https://github.com/o/r/issues/0x10"],
    ["a discussion", "https://github.com/o/r/discussions/1"],
    ["a commit", "https://github.com/o/r/commit/abc123"],
    ["a missing number", "https://github.com/o/r/issues/"],
    ["a missing repository", "https://github.com/o/issues/1"],
    ["a non-ASCII owner", "https://github.com/о/r/issues/1"],
    ["a non-ASCII digit", "https://github.com/o/r/issues/١"],
    ["a script link", "javascript:alert(1)"],
    ["a data link", "data:text/html,<script>alert(1)</script>"],
    ["a protocol-relative link", "//github.com/o/r/issues/1"],
    ["an empty string", ""],
  ])("refuses %s", (_name, url) => {
    expect(parseGithubUrl(url)).toBeNull();
  });

  it.each([null, undefined, 12, true, {}, ["https://github.com/o/r/issues/1"]])("refuses the non-text %j", (value) => {
    expect(parseGithubUrl(value)).toBeNull();
  });
});

describe("sameRepository", () => {
  const issue = "https://github.com/langchain-ai/langchain/issues/1";
  const pull = "https://github.com/langchain-ai/langchain/pull/2";

  it("is true for an issue and a pull request of one repository", () => {
    expect(sameRepository(issue, pull)).toBe(true);
    expect(sameRepository(issue, issue)).toBe(true);
  });

  it("is false for another repository, another owner, a different case, or anything that is not a link", () => {
    expect(sameRepository(issue, "https://github.com/langchain-ai/langgraph/pull/2")).toBe(false);
    expect(sameRepository(issue, "https://github.com/other-owner/langchain/pull/2")).toBe(false);
    expect(sameRepository(issue, "https://github.com/Langchain-AI/langchain/pull/2")).toBe(false);
    expect(sameRepository(issue, "not a link")).toBe(false);
    expect(sameRepository("nope", "nope")).toBe(false);
    expect(sameRepository(issue, 12 as unknown as string)).toBe(false);
  });
});
