import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(file, "utf8");
const withoutImports = (source: string) => source.replace(/^import[\s\S]*?;\n/gm, "");

describe("the admin area is guarded where it is built", () => {
  it.each(["app/admin/layout.tsx", "app/admin/moderation/page.tsx"])("%s calls requireAdmin", (file) => {
    expect(withoutImports(read(file))).toMatch(/await requireAdmin\(\)/);
  });

  it("the moderation action checks the admin before it calls any service", () => {
    const source = withoutImports(read("lib/admin/actionsCore.ts"));
    const body = source.slice(source.indexOf("export async function moderateCore"));
    const guard = body.indexOf("isActiveAdmin(");
    const service = body.indexOf("decide(");
    expect(guard).toBeGreaterThan(-1);
    expect(service).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(service);
  });

  it("the moderation action checks the origin before the admin", () => {
    const source = withoutImports(read("lib/admin/actionsCore.ts"));
    expect(source.indexOf("assertSameOrigin(")).toBeGreaterThan(-1);
    expect(source.indexOf("assertSameOrigin(")).toBeLessThan(source.indexOf("isActiveAdmin("));
  });

  it("the server action file calls moderateCore and nothing else writes", () => {
    const source = withoutImports(read("app/admin/actions.ts"));
    expect(source).toContain("moderateCore(");
    expect(source).not.toMatch(/\b(?:publishHeld|rejectHeld)\w+\(/);
  });
});
