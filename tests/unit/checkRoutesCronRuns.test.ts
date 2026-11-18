import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findViolations } from "@/scripts/check-routes-gated";

// Rule 9 (N10): only the cron wrapper, the metrics service and the alert service name the cron_runs table.

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ALLOWED = ["lib/http/cronRun.ts", "lib/services/metricsService.ts", "lib/services/alertService.ts"];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "cronruns-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const message = (file: string) => `${file}: touches the cron_runs table, which only ${ALLOWED.join(", ")} may`;
const USES = 'import { cronRuns } from "@/db/schema";\nexport const x = cronRuns;\n';

describe("check:routes rule 9: who may name cron_runs", () => {
  it.each([
    ["the schema name", USES],
    ["the table name in SQL", 'export const q = "select * from cron_runs";\n'],
    ["a different case", "export const cronruns = 1;\n"],
    ["a comment that names it", "// read cron_runs here\nexport const x = 1;\n"],
  ])("reports %s outside the three files", (_label, text) => {
    for (const file of ["app/admin/a.ts", "lib/http/a.ts", "lib/services/caseService.ts", "components/a.tsx"]) {
      expect(findViolations(tree({ [file]: text }))).toContain(message(file));
    }
  });

  it.each(ALLOWED)("allows %s", (file) => {
    expect(findViolations(tree({ [file]: USES }))).toEqual([]);
  });

  it("gives no other file of the same name the same allowance", () => {
    const root = tree({ "app/cronRun.ts": USES, "lib/services/cronRun.ts": USES });
    expect(findViolations(root)).toEqual([message("app/cronRun.ts"), message("lib/services/cronRun.ts")]);
  });

  it("only looks under app, lib and components", () => {
    const root = tree({ "db/schema/cronRuns.ts": USES, "tests/x.test.ts": USES, "scripts/x.ts": USES });
    expect(findViolations(root)).toEqual([]);
  });

  it("finds nothing outside the allowed files in this repository", () => {
    expect(findViolations(repo).filter((line) => line.includes("cron_runs"))).toEqual([]);
  });
});
