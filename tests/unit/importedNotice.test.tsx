import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImportedNotice } from "@/components/ImportedNotice";
import { fixUrlFromNote, repositoryOf } from "@/lib/import/sources";

const ISSUE = "https://github.com/langchain-ai/langchain/issues/1234";
const FIX = "https://github.com/langchain-ai/langchain/pull/1240";
const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(1)">[x](javascript:alert(1)) "q" & \u202eevil';

const render = (props: { sourceUrl: unknown; license: unknown; fixUrl: unknown }) => renderToStaticMarkup(<ImportedNotice {...props} />);
const text = (markup: string) => markup.replace(/<[^>]+>/g, "");
const anchors = (markup: string) => markup.match(/<a\b[^>]*>/g) ?? [];

describe("repositoryOf", () => {
  it("gives owner/name for a well-formed issue or pull request link", () => {
    expect(repositoryOf(ISSUE)).toBe("langchain-ai/langchain");
    expect(repositoryOf(FIX)).toBe("langchain-ai/langchain");
  });

  it.each([null, undefined, 12, {}, ["x"], "", "javascript:alert(1)", "http://github.com/a/b/issues/1", "https://github.com/a/b/issues/1?x=1", "https://github.com/a/b/issues/1/"])(
    "gives null for %j",
    (value) => {
      expect(repositoryOf(value)).toBeNull();
    },
  );
});

describe("fixUrlFromNote", () => {
  it("reads the link the import puts on the last line of the note", () => {
    expect(fixUrlFromNote(`Fixed upstream: langchain-ai/langchain change #1240\n${FIX}`)).toBe(FIX);
  });

  it("ignores blank lines and spaces after it", () => {
    expect(fixUrlFromNote(`Note\n${FIX}  \n\n`)).toBe(FIX);
  });

  it("accepts a note that is only the link", () => {
    expect(fixUrlFromNote(FIX)).toBe(FIX);
  });

  it.each([
    ["a note with no link", "Fixed upstream: change 5"],
    ["an issue link, which is not a fix", `Note\n${ISSUE}`],
    ["a link that is not on the last line", `${FIX}\nand then some words`],
    ["a link with words around it", `Note\nsee ${FIX} for the fix`],
    ["a hostile last line", "Note\njavascript:alert(1)"],
    ["a look-alike host", "Note\nhttps://github.com.evil.example/a/b/pull/1"],
    ["an empty note", ""],
    ["null", null],
    ["a number", 12],
  ])("gives null for %s", (_name, note) => {
    expect(fixUrlFromNote(note)).toBeNull();
  });
});

describe("ImportedNotice", () => {
  it("says what the case is, in fixed words", () => {
    const words = text(render({ sourceUrl: ISSUE, license: "MIT", fixUrl: FIX }));
    expect(words).toContain("IMPORTED");
    expect(words).toContain("Imported from langchain-ai/langchain (licence MIT).");
    expect(words).toContain("Paraphrased from a public issue; not verified by this court.");
    expect(words).toContain("Imported cases earn no reputation.");
  });

  it("links to the original issue and to the fix, and only those, safely", () => {
    const markup = render({ sourceUrl: ISSUE, license: "MIT", fixUrl: FIX });
    expect(anchors(markup)).toHaveLength(2);
    for (const [url, label] of [[ISSUE, "Original issue"], [FIX, "Merged fix"]]) {
      const anchor = anchors(markup).find((entry) => entry.includes(`href="${url}"`));
      expect(anchor, url).toBeDefined();
      expect(anchor).toContain('target="_blank"');
      expect(anchor).toContain('rel="noopener noreferrer nofollow"');
      expect(markup).toContain(`>${label}</a>`);
    }
  });

  it("links only to the issue when there is no fix", () => {
    const markup = render({ sourceUrl: ISSUE, license: "MIT", fixUrl: null });
    expect(anchors(markup)).toHaveLength(1);
    expect(markup).toContain(`href="${ISSUE}"`);
    expect(text(markup)).not.toContain("Merged fix");
  });

  it("uses only a section, paragraphs, spans and the two links", () => {
    const markup = render({ sourceUrl: ISSUE, license: "MIT", fixUrl: FIX });
    const tags = new Set([...markup.matchAll(/<([a-z][a-z0-9]*)\b/gi)].map((match) => match[1].toLowerCase()));
    expect([...tags].filter((tag) => !["section", "p", "span", "a"].includes(tag))).toEqual([]);
  });

  const NOT_LINKS: Array<[string, unknown]> = [
    ["a script link", "javascript:alert(1)"],
    ["a data link", "data:text/html,<script>alert(1)</script>"],
    ["plain http", "http://github.com/langchain-ai/langchain/issues/1"],
    ["a look-alike host", "https://github.com.evil.example/langchain-ai/langchain/issues/1"],
    ["credentials", "https://user:pw@github.com/langchain-ai/langchain/issues/1"],
    ["a port", "https://github.com:8080/langchain-ai/langchain/issues/1"],
    ["a query", "https://github.com/langchain-ai/langchain/issues/1?x=1"],
    ["a fragment", "https://github.com/langchain-ai/langchain/issues/1#c"],
    ["a trailing slash", "https://github.com/langchain-ai/langchain/issues/1/"],
    ["a trailing part", "https://github.com/langchain-ai/langchain/pull/1/files"],
    ["another site", "https://example.com/langchain-ai/langchain/issues/1"],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a number", 12],
    ["an object", { href: ISSUE }],
    ["a list", [ISSUE]],
  ];

  it.each(NOT_LINKS)("makes no link from %s used as the issue link", (_name, value) => {
    const markup = render({ sourceUrl: value, license: "MIT", fixUrl: null });
    expect(anchors(markup)).toHaveLength(0);
    expect(text(markup)).toContain("Paraphrased from a public issue; not verified by this court.");
  });

  it.each(NOT_LINKS)("makes no link from %s used as the fix link", (_name, value) => {
    const markup = render({ sourceUrl: ISSUE, license: "MIT", fixUrl: value });
    expect(anchors(markup)).toHaveLength(1);
    expect(markup).toContain(`href="${ISSUE}"`);
  });

  it("does not take a pull request link as the issue, or an issue link as the fix", () => {
    expect(anchors(render({ sourceUrl: FIX, license: "MIT", fixUrl: null }))).toHaveLength(0);
    expect(anchors(render({ sourceUrl: ISSUE, license: "MIT", fixUrl: ISSUE }))).toHaveLength(1);
  });

  it("shows a link it cannot use as plain text, marked as not a link", () => {
    const words = text(render({ sourceUrl: "javascript:alert(1)", license: "MIT", fixUrl: "https://example.com/x" }));
    expect(words).toContain("javascript:alert(1)");
    expect(words).toContain("https://example.com/x");
    expect(words).toContain("not a link");
  });

  it("says where the case came from only when the link is a real one", () => {
    expect(text(render({ sourceUrl: "javascript:alert(1)", license: "MIT", fixUrl: null }))).not.toContain("Imported from langchain");
    expect(text(render({ sourceUrl: null, license: "MIT", fixUrl: null }))).toContain("Imported from a public issue");
  });

  it("shows hostile text as text: no element, no link, no handler", () => {
    const markup = render({ sourceUrl: HOSTILE, license: HOSTILE, fixUrl: HOSTILE });
    expect(markup).not.toMatch(/<script|<img|<iframe|<style/i);
    expect(markup.replace(/="[^"]*"/g, '=""')).not.toMatch(/<[^>]*\sonerror\s*=/i);
    expect(anchors(markup)).toHaveLength(0);
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows the licence as stored, as text, even when it differs from the source list", () => {
    const words = text(render({ sourceUrl: ISSUE, license: "GPL-3.0", fixUrl: null }));
    expect(words).toContain("(licence GPL-3.0)");
    expect(anchors(render({ sourceUrl: ISSUE, license: "GPL-3.0", fixUrl: null }))).toHaveLength(1);
  });

  it("falls back to the licence of the source list when none is stored", () => {
    expect(text(render({ sourceUrl: ISSUE, license: null, fixUrl: null }))).toContain("(licence MIT)");
  });

  it("names the repository without a licence when it is not on the list and none is stored", () => {
    const words = text(render({ sourceUrl: "https://github.com/someone/else/issues/9", license: null, fixUrl: null }));
    expect(words).toContain("Imported from someone/else.");
    expect(words).not.toContain("licence");
  });
});
