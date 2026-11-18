import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findViolations } from "@/scripts/check-routes-gated";

// Rule 8 (N10): nothing under app/, lib/ or components/ except lib/services/killSwitchService.ts names the system_flags table.

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MARKER = "PLANTED_CONTENT_MARKER_456";
const SERVICE = "lib/services/killSwitchService.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "flags-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const message = (file: string) => `${file}: touches the system_flags table, which only ${SERVICE} may`;
const IMPORTS = 'import { systemFlags } from "@/db/schema";\nexport const x = systemFlags;\n';

describe("check:routes rule 8: only the kill switch service touches system_flags", () => {
  it.each([
    ["the schema name", 'import { systemFlags } from "@/db/schema";\nexport const x = systemFlags;\n'],
    ["the table name in SQL", 'export const q = "update system_flags set value = true";\n'],
    ["a different case", "export const systemflags = 1;\n"],
    ["a comment that names it", "// do not touch system_flags here\nexport const x = 1;\n"],
  ])("reports %s outside the service", (_label, text) => {
    for (const file of ["app/admin/a.ts", "lib/http/a.ts", "lib/admin/a.ts", "components/a.tsx", "lib/services/caseService.ts"]) {
      expect(findViolations(tree({ [file]: text }))).toContain(message(file));
    }
  });

  it("allows the kill switch service itself", () => {
    expect(findViolations(tree({ [SERVICE]: IMPORTS }))).toEqual([]);
  });

  it("gives no other file of the same name the same allowance", () => {
    const root = tree({ "lib/http/killSwitchService.ts": IMPORTS, "app/killSwitchService.ts": IMPORTS });
    const violations = findViolations(root);
    expect(violations).toContain(message("lib/http/killSwitchService.ts"));
    expect(violations).toContain(message("app/killSwitchService.ts"));
  });

  it("does not mind files that talk about the kill switch without naming the table", () => {
    const root = tree({
      "lib/http/a.ts": 'import { getKillSwitch } from "@/lib/services/killSwitchService";\nexport const x = getKillSwitch;\n',
      "lib/http/b.ts": 'export const killSwitch = { on: false };\n',
    });
    expect(findViolations(root)).toEqual([]);
  });

  it("only looks under app, lib and components", () => {
    const root = tree({ "db/schema/systemFlags.ts": IMPORTS, "tests/x.test.ts": IMPORTS, "scripts/x.ts": IMPORTS, "db/seed.ts": IMPORTS });
    expect(findViolations(root)).toEqual([]);
  });

  it("says it once per file, however many times the name appears", () => {
    const root = tree({ "lib/http/a.ts": "systemFlags; systemFlags; system_flags;\n" });
    expect(findViolations(root).filter((line) => line.includes("system_flags"))).toEqual([message("lib/http/a.ts")]);
  });

  it("names the file and the rule, never the content", () => {
    const root = tree({ "lib/http/a.ts": `// ${MARKER} systemFlags\n` });
    expect(JSON.stringify(findViolations(root))).not.toContain(MARKER);
  });

  it("finds nothing outside the kill switch service in this repository", () => {
    expect(findViolations(repo).filter((line) => line.includes("system_flags"))).toEqual([]);
  });
});
