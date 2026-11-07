import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findViolations } from "@/scripts/check-routes-gated";

// Rule 7 (N9): only lib/services/importService.ts may give a case, or a verdict, the value "imported".

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MARKER = "PLANTED_CONTENT_MARKER_123";
const SERVICE = "lib/services/importService.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A small repository with nothing for the other rules to find, plus the files a test passes in.
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "imported-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const message = (file: string) => `${file}: sets source, decidedBy or verificationLevel to imported, which only ${SERVICE} may`;
const wrap = (line: string) => `export const x = ${line};\n`;
const violationsFor = (file: string, text: string) => findViolations(tree({ [file]: text })).filter((line) => line.startsWith(`${file}:`));

const ASSIGNMENTS: Array<[string, string]> = [
  ["a property with double quotes", wrap('{ source: "imported" }')],
  ["a property with single quotes", wrap("{ source: 'imported' }")],
  ["a property with backticks", wrap("{ source: `imported` }")],
  ["decidedBy", wrap('{ decidedBy: "imported" }')],
  ["verificationLevel", wrap('{ verificationLevel: "imported" }')],
  ["decided_by", wrap('{ decided_by: "imported" }')],
  ["verification_level", wrap('{ verification_level: "imported" }')],
  ["a quoted key", wrap('{ "source": "imported" }')],
  ["a property followed by more", wrap('{ source: "imported", title: "T" }')],
  ["a property that closes the object", wrap('{ title: "T", source: "imported" }')],
  ["a property on its own line", 'export const x = {\n  title: "T",\n  source: "imported"\n};\n'],
  ["a const assertion", wrap('{ source: "imported" as const }')],
  ["an update", 'await db.update(cases).set({ source: "imported" }).where(eq(cases.id, id));\n'],
  ["an insert", 'await db.insert(rows).values({ agentId, source: "imported", sourceUrl });\n'],
  ["an assignment to a field", 'row.source = "imported";\n'],
  ["an assignment to a variable", 'let decidedBy = "operator";\ndecidedBy = "imported";\n'],
  ["an assignment with no spaces", 'row.verificationLevel="imported";\n'],
  ["SQL that sets the value", 'const q = "update cases set source = \'imported\' where id = 1";\n'],
];

describe("check:routes rule 7: only the import service makes an imported case", () => {
  it.each(ASSIGNMENTS)("reports %s", (_name, text) => {
    for (const file of ["app/api/v1/things/route.ts", "app/(public)/page.tsx", "components/Badge.tsx", "lib/http/handlers/cases.ts", "lib/services/caseService.ts"]) {
      expect(violationsFor(file, text)).toEqual([message(file)]);
    }
  });

  it("allows the import service itself", () => {
    const text = 'await tx.insert(rows).values({ source: "imported", decidedBy: "imported", verificationLevel: "imported" });\n';
    expect(findViolations(tree({ [SERVICE]: text }))).toEqual([]);
  });

  it("gives no other file of the same name the same allowance", () => {
    const text = wrap('{ source: "imported" }');
    expect(violationsFor("lib/http/importService.ts", text)).toEqual([message("lib/http/importService.ts")]);
    expect(violationsFor("app/importService.ts", text)).toEqual([message("app/importService.ts")]);
    expect(violationsFor("lib/import/importService.ts", text)).toEqual([message("lib/import/importService.ts")]);
  });

  it.each([
    ["a strict comparison", 'if (c.source === "imported") return true;\n'],
    ["a loose comparison", 'if (c.source == "imported") return true;\n'],
    ["a negative comparison", 'if (c.source !== "imported") return true;\n'],
    ["a negative loose comparison", 'if (verdict.decidedBy != "imported") return true;\n'],
    ["a drizzle comparison", 'const rows = await db.select().from(cases).where(eq(cases.source, "imported"));\n'],
    ["a switch", 'switch (c.source) { case "imported": return 1; }\n'],
    ["a key named imported", 'const LABELS = { imported: "IMPORTED", operator: "OPERATOR" };\n'],
    ["a type that lists the value", 'export type Level = { verificationLevel: "operator_confirmed" | "self_resolved" | "imported" };\n'],
    ["a type that starts with the value", 'export type Level = { verificationLevel: "imported" | "auto_verified" };\n'],
    ["a type member", 'export interface Row {\n  source: "imported";\n}\n'],
    ["an audit action", 'await writeAudit(tx, { action: "case.imported", target: id });\n'],
    ["the word in a sentence", "// An imported case is labelled imported.\n"],
    ["a different field", 'const x = { status: "imported", kind: "imported" };\n'],
  ])("allows %s", (_name, text) => {
    for (const file of ["app/(public)/page.tsx", "components/Badge.tsx", "lib/services/observerService.ts"]) {
      expect(violationsFor(file, text)).toEqual([]);
    }
  });

  it("only looks under app, lib and components", () => {
    const text = wrap('{ source: "imported" }');
    const root = tree({ "db/seed.ts": text, "db/schema/cases.ts": text, "scripts/x.ts": text, "tests/x.test.ts": text });
    expect(findViolations(root)).toEqual([]);
  });

  it("says it once per file, however many times the value is set", () => {
    const text = 'const a = { source: "imported" };\nconst b = { decidedBy: "imported" };\nrow.verificationLevel = "imported";\n';
    expect(violationsFor("lib/http/a.ts", text)).toEqual([message("lib/http/a.ts")]);
  });

  it("names the file and the rule, never the content", () => {
    const text = `// ${MARKER}\nconst a = { source: "imported" };\n`;
    const report = findViolations(tree({ "lib/http/a.ts": text })).join("\n");
    expect(report).toContain("lib/http/a.ts");
    expect(report).not.toContain(MARKER);
  });

  it("finds nothing in this repository, where the import service is the only one that sets the value", () => {
    expect(findViolations(repo).filter((line) => line.includes("imported"))).toEqual([]);
  });
});
