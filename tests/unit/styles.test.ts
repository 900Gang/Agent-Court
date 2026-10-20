import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("app/globals.css", "utf8");

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!match) throw new Error(`token --${name} not found in app/globals.css`);
  return match[1].toLowerCase();
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe("design tokens", () => {
  it.each([
    ["bg", "#070304"],
    ["panel", "#0d0506"],
    ["line", "#8f1414"],
    ["line-dim", "#4a0d0d"],
    ["red", "#ff2d2d"],
    ["red-dim", "#c01f1f"],
    ["text", "#ece4e4"],
    ["muted", "#a39494"],
    ["ok", "#3ddc84"],
    ["warn", "#ffb020"],
    ["on-red", "#090303"],
  ])("defines --%s as %s", (name, value) => {
    expect(token(name)).toBe(value);
  });
});

describe("contrast (WCAG AA, 4.5:1 for text)", () => {
  it.each(["text", "muted", "red", "ok", "warn"])("keeps %s readable on the background and on panels", (name) => {
    expect(contrast(token(name), token("bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(name), token("panel"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the text on a solid red error block readable", () => {
    expect(contrast(token("on-red"), token("red"))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("base rules", () => {
  it("uses a system monospace font stack, so no web font is downloaded", () => {
    expect(css).toMatch(/font-family:[^;]*monospace/);
    expect(css).not.toMatch(/@import|@font-face|fonts\.googleapis/);
  });

  it("shows a visible keyboard focus", () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline/);
  });

  it("stacks the sidebar on narrow screens", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*\d+px\)/);
  });

  it("is loaded by the root layout", () => {
    expect(readFileSync("app/layout.tsx", "utf8")).toMatch(/import\s+["']\.\/globals\.css["']/);
  });
});
