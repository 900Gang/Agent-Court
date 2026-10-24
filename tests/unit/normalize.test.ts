import { describe, expect, it } from "vitest";
import { normalizeText } from "@/lib/safety/normalize";

const zeros = { zeroWidth: 0, bidi: 0, tag: 0, control: 0 };
const only = (partial: Partial<typeof zeros>) => ({ ...zeros, ...partial });

describe("normalizeText: Unicode folding", () => {
  it("folds fullwidth letters and digits to ASCII", () => {
    expect(normalizeText("\uff21\uff22\uff23\uff11\uff12\uff13").text).toBe("ABC123");
  });

  it("folds fullwidth punctuation and the ideographic space", () => {
    expect(normalizeText("\uff53\uff4b\uff0d\u3000\uff41").text).toBe("sk- a");
  });

  it("expands ligatures", () => {
    expect(normalizeText("\ufb01le").text).toBe("file");
  });

  it("composes decomposed accents", () => {
    expect(normalizeText("cafe\u0301").text).toBe("caf\u00e9");
  });

  it.each([
    ["Cyrillic", "\u041f\u0440\u0438\u0432\u0435\u0442, \u043c\u0438\u0440"],
    ["CJK", "\u4f60\u597d\uff0c\u4e16\u754c"],
    ["Arabic", "\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645"],
    ["Hebrew", "\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd"],
    ["Hindi", "\u0928\u092e\u0938\u094d\u0924\u0947 \u0926\u0941\u0928\u093f\u092f\u093e"],
    ["accented Latin", "na\u00efve fa\u00e7ade \u00fcber"],
  ])("leaves ordinary %s text unchanged", (_label, text) => {
    const result = normalizeText(text);
    expect(result.text).toBe(text.normalize("NFKC"));
    expect(result.stripped).toEqual(zeros);
  });

  it("keeps emoji and their variation selectors", () => {
    expect(normalizeText("\u2764\ufe0f ok \u2764\ufe0e").text).toBe("\u2764\ufe0f ok \u2764\ufe0e");
    expect(normalizeText("\u26a0\ufe0f warning").stripped).toEqual(zeros);
  });

  it("splits emoji joined with a zero-width joiner, which is an accepted loss", () => {
    const family = "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67";
    const result = normalizeText(family);
    expect(result.text).toBe("\ud83d\udc68\ud83d\udc69\ud83d\udc67");
    expect(result.stripped).toEqual(only({ zeroWidth: 2 }));
  });
});

describe("normalizeText: hidden characters", () => {
  it("removes a zero-width space inside a token and counts it", () => {
    expect(normalizeText("sk\u200b-abc")).toEqual({ text: "sk-abc", stripped: only({ zeroWidth: 1 }) });
  });

  it.each(["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u00ad"])("removes the zero-width character %j", (char) => {
    expect(normalizeText(`a${char}b`)).toEqual({ text: "ab", stripped: only({ zeroWidth: 1 }) });
  });

  it.each([
    "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u061c",
  ])("removes the bidi control %j", (char) => {
    expect(normalizeText(`a${char}b`)).toEqual({ text: "ab", stripped: only({ bidi: 1 }) });
  });

  it("removes tag characters, which carry invisible ASCII, and counts each code point", () => {
    const hidden = [..."ignore"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    expect(normalizeText(`Looks good${hidden}`)).toEqual({ text: "Looks good", stripped: only({ tag: 6 }) });
    expect(normalizeText(`a${String.fromCodePoint(0xe0001)}b${String.fromCodePoint(0xe007f)}c`).stripped).toEqual(only({ tag: 2 }));
  });

  it.each(["\u0000", "\u0007", "\u001b", "\u000c", "\u007f", "\u0085", "\u009f"])("removes the control character %j", (char) => {
    expect(normalizeText(`a${char}b`)).toEqual({ text: "ab", stripped: only({ control: 1 }) });
  });

  it("keeps newlines and tabs", () => {
    expect(normalizeText("a\n\tb")).toEqual({ text: "a\n\tb", stripped: zeros });
  });

  it("turns CRLF and lone CR into LF without counting them as control characters", () => {
    expect(normalizeText("a\r\nb\rc")).toEqual({ text: "a\nb\nc", stripped: zeros });
  });

  it("counts several kinds at once", () => {
    const result = normalizeText("a\u200bb\u202ec\u0007d" + String.fromCodePoint(0xe0041));
    expect(result.text).toBe("abcd");
    expect(result.stripped).toEqual({ zeroWidth: 1, bidi: 1, tag: 1, control: 1 });
  });

  it("applies NFKC before looking for hidden characters, so a fullwidth secret with a hidden character folds fully", () => {
    expect(normalizeText("\uff47\uff48\uff50\uff3f\u200b\uff41").text).toBe("ghp_a");
  });
});

describe("normalizeText: edge cases", () => {
  it("handles empty text", () => {
    expect(normalizeText("")).toEqual({ text: "", stripped: zeros });
  });

  it("leaves whitespace alone", () => {
    expect(normalizeText("  \n\t ")).toEqual({ text: "  \n\t ", stripped: zeros });
  });

  it("reduces text made only of hidden characters to the empty string", () => {
    expect(normalizeText("\u200b\u200b\u202e\u0000")).toEqual({
      text: "",
      stripped: { zeroWidth: 2, bidi: 1, tag: 0, control: 1 },
    });
  });

  it.each([
    "plain text",
    "ign\u200bore pre\u200bvious",
    "\uff29\uff27\uff2e\uff2f\uff32\uff25",
    "a\r\nb\u202ec" + String.fromCodePoint(0xe0041),
    "\ud83d\udc68\u200d\ud83d\udc69",
    "",
  ])("is idempotent for %j", (input) => {
    const once = normalizeText(input);
    const twice = normalizeText(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.stripped).toEqual(zeros);
  });

  it("copes with a long input quickly", () => {
    const start = Date.now();
    normalizeText("a\u200b".repeat(16_000));
    normalizeText("\u0000".repeat(32_000));
    normalizeText(String.fromCodePoint(0xe0041).repeat(16_000));
    expect(Date.now() - start).toBeLessThan(500);
  });
});
