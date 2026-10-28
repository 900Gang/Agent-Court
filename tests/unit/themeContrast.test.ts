import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The stylesheet is the source of truth for the palettes, so this test reads it and does not repeat the colours.
const css = readFileSync("app/globals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The text between the braces that open at `open` (the index of the "{"), matching nested braces. */
function blockFrom(source: string, open: number): { inner: string; end: number } {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return { inner: source.slice(open + 1, i), end: i + 1 };
  }
  throw new Error("unbalanced braces in globals.css");
}

function rootBlock(source: string): { inner: string; start: number; end: number } {
  const match = /(^|\n)\s*:root\s*\{/.exec(source);
  if (!match) throw new Error("no :root block");
  const open = source.indexOf("{", match.index);
  const { inner, end } = blockFrom(source, open);
  return { inner, start: match.index, end };
}

const dark = rootBlock(css);
const lightMedia = (() => {
  const at = css.indexOf("@media (prefers-color-scheme: light)");
  if (at === -1) return null;
  const { inner, end } = blockFrom(css, css.indexOf("{", at));
  return { inner, start: at, end };
})();
const light = lightMedia ? rootBlock(lightMedia.inner) : null;

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[match[1]] = match[2].trim();
  return out;
}

const darkTokens = tokens(dark.inner);
const lightTokens = { ...darkTokens, ...(light ? tokens(light.inner) : {}) };

function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Pairs that are text or controls on a background. Decoration-only tokens (--red-dim, --line, --line-dim and the
// borders and washes) are deliberately not here: they carry no information that is not also in text.
const PAIRS: Array<[string, string]> = [
  ["--text", "--bg"],
  ["--text", "--panel"],
  ["--text", "--page"],
  ["--muted", "--bg"],
  ["--muted", "--panel"],
  ["--muted", "--page"],
  ["--red", "--bg"],
  ["--red", "--panel"],
  ["--ok", "--bg"],
  ["--ok", "--panel"],
  ["--warn", "--bg"],
  ["--warn", "--panel"],
  ["--on-red", "--red"],
  ["--code-text", "--code-bg"],
];

describe("the stylesheet has two palettes", () => {
  it("defines every token the pairs use, in the dark set", () => {
    for (const name of new Set(PAIRS.flat())) expect(darkTokens[name], name).toMatch(/^#[0-9a-f]{3,6}$/i);
  });

  it("has a light set that follows the visitor's system setting, in one media block", () => {
    expect(lightMedia, "no @media (prefers-color-scheme: light) block").not.toBeNull();
    expect(light, "no :root inside the light media block").not.toBeNull();
    expect(css.split("@media (prefers-color-scheme: light)")).toHaveLength(2);
  });

  it("declares both schemes, so form controls and scrollbars follow", () => {
    expect(darkTokens["color-scheme"] ?? /color-scheme\s*:\s*dark light/.test(dark.inner)).toBeTruthy();
    expect(dark.inner).toMatch(/color-scheme\s*:\s*dark light/);
  });

  it("makes the light set really light and the dark set really dark", () => {
    expect(luminance(darkTokens["--bg"])).toBeLessThan(0.05);
    expect(luminance(darkTokens["--page"])).toBeLessThan(0.1);
    expect(luminance(lightTokens["--bg"])).toBeGreaterThan(0.6);
    expect(luminance(lightTokens["--page"])).toBeGreaterThan(0.5);
    expect(luminance(lightTokens["--text"])).toBeLessThan(0.2);
  });
});

describe.each([
  ["dark", darkTokens],
  ["light", lightTokens],
])("contrast in the %s palette", (_name, set) => {
  it.each(PAIRS)("%s on %s is at least 4.5:1", (foreground, background) => {
    expect(set[foreground], foreground).toBeDefined();
    expect(set[background], background).toBeDefined();
    const ratio = contrast(set[foreground], set[background]);
    expect(ratio, `${foreground} ${set[foreground]} on ${background} ${set[background]} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

describe("no colour is written outside the tokens", () => {
  // Everything except the two token blocks.
  const rest = (() => {
    let source = css;
    if (lightMedia) source = source.slice(0, lightMedia.start) + source.slice(lightMedia.end);
    return source.slice(0, dark.start) + source.slice(dark.end);
  })();

  it("has no hex colour, rgb(), rgba(), hsl() or hsla() in any rule", () => {
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(rest.match(/\b(?:rgba?|hsla?)\(/g) ?? []).toEqual([]);
  });

  it("uses only variables that the dark set defines", () => {
    const used = new Set([...rest.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1]));
    const missing = [...used].filter((name) => !(name in darkTokens));
    expect(missing).toEqual([]);
  });

  it("sets the page background and text from tokens", () => {
    expect(rest).toMatch(/html\s*\{[^}]*background\s*:\s*var\(--page\)/);
    expect(rest).toMatch(/body\s*\{[^}]*background\s*:\s*var\(--page\)/);
    expect(rest).toMatch(/body\s*\{[^}]*color\s*:\s*var\(--text\)/);
  });
});
