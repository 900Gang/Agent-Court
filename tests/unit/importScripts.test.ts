import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadEntries, parseRunArgs } from "@/scripts/import-seeds/run";
import { entryFor } from "../helpers/importEntries";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MARKER = "PLANTED-MARKER";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "import-run-"));
  dirs.push(dir);
  return dir;
}
function write(dir: string, name: string, content: unknown): string {
  const file = path.join(dir, name);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}
const source = (file: string) => readFileSync(path.join(repo, file), "utf8");

describe("package.json", () => {
  const pkg = JSON.parse(source("package.json")) as { scripts: Record<string, string> };

  it("has the three import commands", () => {
    expect(pkg.scripts["import:seeds"]).toMatch(/scripts\/import-seeds\/run\.ts/);
    expect(pkg.scripts["import:fetch"]).toMatch(/scripts\/import-seeds\/fetch-candidates\.ts/);
    expect(pkg.scripts["import:show"]).toMatch(/scripts\/import-seeds\/show\.ts/);
  });

  it("reads the database address the way the other scripts do, and only the import command needs it", () => {
    expect(pkg.scripts["import:seeds"]).toContain("--env-file=.env.local");
    expect(pkg.scripts["import:seeds"]).toContain("--conditions=react-server");
    expect(pkg.scripts["import:fetch"]).not.toContain("env-file");
    expect(pkg.scripts["import:show"]).not.toContain("env-file");
  });
});

describe("what the scripts import", () => {
  it("lets the run script reach the court only through the runner", () => {
    const text = source("scripts/import-seeds/run.ts");
    expect(text).toMatch(/@\/lib\/import\/runner/);
    expect(text).not.toMatch(/@\/lib\/services\//);
    expect(text).not.toMatch(/@\/db\/schema/);
    expect(text).not.toMatch(/@\/lib\/import\/identity/);
  });

  it.each(["fetch-candidates", "show", "gh"])("keeps %s away from the database and the services", (name) => {
    const text = source(`scripts/import-seeds/${name}.ts`);
    expect(text).not.toMatch(/@\/db\//);
    expect(text).not.toMatch(/@\/lib\/services\//);
    expect(text).not.toMatch(/@\/lib\/import\/runner/);
  });

  it("starts gh without a shell, and never with exec or spawn", () => {
    const text = source("scripts/import-seeds/gh.ts");
    expect(text).toMatch(/execFile/);
    expect(text).not.toMatch(/\bexec\(|\bexecSync\(|\bspawn\(|\bspawnSync\(|shell:\s*true/);
  });

  it("only reads from GitHub: no method other than GET appears in the scripts", () => {
    for (const name of ["fetch-candidates", "show", "gh"]) {
      const text = source(`scripts/import-seeds/${name}.ts`);
      expect(text).not.toMatch(/["'](POST|PUT|PATCH|DELETE)["']/);
    }
  });
});

describe("parseRunArgs", () => {
  it("is a dry run over the manifest folder by default", () => {
    expect(parseRunArgs([])).toEqual({ apply: false, limit: undefined, files: [], dir: "data/imports" });
  });

  it("takes --apply, --limit, --dir, --file and plain file names", () => {
    expect(parseRunArgs(["--apply", "--limit", "5", "--dir", "d", "--file", "a.json", "b.json", "--file", "c.json"])).toEqual({
      apply: true,
      limit: 5,
      files: ["a.json", "b.json", "c.json"],
      dir: "d",
    });
  });

  it.each([["--bogus"], ["--limit"], ["--limit", "x"], ["--limit", "0"], ["--limit", "-1"], ["--limit", "1.5"], ["--limit", "1001"], ["--dir"], ["--file"], ["--apply=true"]])(
    "refuses %j with the usage line",
    (...argv) => {
      expect(() => parseRunArgs(argv)).toThrow(/Usage/);
    },
  );
});

describe("loadEntries", () => {
  it("reads the lists of several files, in order", async () => {
    const dir = temp();
    const a = write(dir, "a.json", [entryFor(1), entryFor(2)]);
    const b = write(dir, "b.json", [entryFor(3)]);
    const { entries, problems } = await loadEntries([a, b]);
    expect(problems).toEqual([]);
    expect(entries).toEqual([entryFor(1), entryFor(2), entryFor(3)]);
  });

  it("reads a file that starts with a byte order mark", async () => {
    const dir = temp();
    const { entries, problems } = await loadEntries([write(dir, "a.json", `\uFEFF${JSON.stringify([entryFor(1)])}`)]);
    expect(problems).toEqual([]);
    expect(entries).toHaveLength(1);
  });

  it("reports a file that cannot be read, is not JSON, or is not a list, without quoting it", async () => {
    const dir = temp();
    const missing = path.join(dir, "missing.json");
    const bad = write(dir, "bad.json", `${MARKER} {{{`);
    const notList = write(dir, "object.json", { [MARKER]: MARKER });
    const { entries, problems } = await loadEntries([missing, bad, notList]);
    expect(entries).toEqual([]);
    expect(problems).toEqual([`${missing}: cannot be read`, `${bad}: not valid JSON`, `${notList}: must be a list`]);
    expect(problems.join("\n")).not.toContain(MARKER);
  });

  it("keeps the entries of the good files when another file is bad", async () => {
    const dir = temp();
    const good = write(dir, "good.json", [entryFor(1)]);
    const bad = write(dir, "bad.json", "nope");
    const { entries, problems } = await loadEntries([bad, good]);
    expect(entries).toHaveLength(1);
    expect(problems).toHaveLength(1);
  });
});

describe("the run command", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/import-seeds/run.ts", ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });

  it("exits non-zero with the usage line for an unknown flag, before it touches the database", () => {
    const result = run("--bogus");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Usage/);
  }, 60_000);

  it("exits 1 for an unreadable list without reaching the database, and never prints the file", () => {
    const dir = temp();
    const result = run(write(dir, "bad.json", `${MARKER} {{{`));
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/not valid JSON/);
    expect(result.stdout + result.stderr).not.toContain(MARKER);
  }, 60_000);
});

describe("the fetch and show commands", () => {
  const run = (script: string, ...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", `scripts/import-seeds/${script}.ts`, ...args], { cwd: repo, encoding: "utf8" });

  it.each([
    ["fetch-candidates", ["--bogus"]],
    ["fetch-candidates", []],
    ["show", []],
    ["show", ["langchain-ai/langchain"]],
  ])("%s %j exits non-zero with the usage line, before any call to GitHub", (script, args) => {
    const result = run(script, ...args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Usage/);
  }, 60_000);

  it("refuses a repository that is not on the list, before any call to GitHub", () => {
    const result = run("fetch-candidates", "someone/else");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not on the list/);
  }, 60_000);
});
