import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findViolations } from "@/scripts/check-routes-gated";

// Rule 10 (N11): only lib/services/inviteService.ts names the operator_invites table.

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVICE = "lib/services/inviteService.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "invites-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const message = (file: string) => `${file}: touches the operator_invites table, which only ${SERVICE} may`;
const USES = 'import { operatorInvites } from "@/db/schema";\nexport const x = operatorInvites;\n';

describe("check:routes rule 10: only the invite service touches operator_invites", () => {
  it.each([
    ["the schema name", USES],
    ["the table name in SQL", 'export const q = "select * from operator_invites";\n'],
    ["a different case", "export const operatorinvites = 1;\n"],
    ["a comment that names it", "// read operator_invites here\nexport const x = 1;\n"],
  ])("reports %s outside the service", (_label, text) => {
    for (const file of ["app/admin/a.ts", "lib/http/a.ts", "lib/admin/a.ts", "components/a.tsx", "lib/services/operatorService.ts"]) {
      expect(findViolations(tree({ [file]: text }))).toContain(message(file));
    }
  });

  it("allows the invite service itself", () => {
    expect(findViolations(tree({ [SERVICE]: USES }))).toEqual([]);
  });

  it("gives no other file of the same name the same allowance", () => {
    const root = tree({ "lib/http/inviteService.ts": USES, "app/inviteService.ts": USES });
    expect(findViolations(root)).toEqual([message("app/inviteService.ts"), message("lib/http/inviteService.ts")]);
  });

  it("does not mind files that talk about invites without naming the table", () => {
    const root = tree({
      "lib/http/a.ts": 'import { isInvited } from "@/lib/services/inviteService";\nexport const x = isInvited;\n',
      "lib/http/b.ts": "export const inviteOnly = true;\n",
    });
    expect(findViolations(root)).toEqual([]);
  });

  it("only looks under app, lib and components", () => {
    const root = tree({ "db/schema/operatorInvites.ts": USES, "tests/x.test.ts": USES, "scripts/x.ts": USES });
    expect(findViolations(root)).toEqual([]);
  });

  it("finds nothing outside the invite service in this repository", () => {
    expect(findViolations(repo).filter((line) => line.includes("operator_invites"))).toEqual([]);
  });
});
