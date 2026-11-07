import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { IMPORT } from "@/lib/config/constants";
import { rawTextPaths, WORK_DIR } from "@/lib/import/workFolder";
import { checkManifests, formatCheckReport, parseCheckArgs, resolveManifestFiles } from "@/scripts/import-seeds/check";
import { entryFor, goodEntry, type EntryInput } from "../helpers/importEntries";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MARKER = "PLANTED-MARKER";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "import-check-"));
  dirs.push(dir);
  return dir;
}

function manifest(dir: string, name: string, content: unknown): string {
  const file = path.join(dir, name);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

function cache(work: string, entry: EntryInput, issueText: string, fixText: string | null): void {
  const paths = rawTextPaths(work, entry.issueUrl, entry.fixUrl);
  if (!paths) throw new Error("test entry has bad links");
  mkdirSync(path.dirname(paths.issue), { recursive: true });
  writeFileSync(paths.issue, issueText);
  if (fixText !== null) writeFileSync(paths.fix, fixText);
}

const UNRELATED = "Nothing here resembles the paraphrase, it talks about configuration files that are read once at start up.";

describe("rawTextPaths", () => {
  it("puts the issue text and the fix text in the work folder, by repository and number", () => {
    const paths = rawTextPaths("work", "https://github.com/langchain-ai/langchain/issues/12", "https://github.com/langchain-ai/langchain/pull/34");
    expect(paths).toEqual({
      issue: path.join("work", "raw", "langchain-ai", "langchain", "issue-12.txt"),
      fix: path.join("work", "raw", "langchain-ai", "langchain", "pull-34.txt"),
    });
  });

  it("gives nothing for a link that is not a well-formed issue and pull request link", () => {
    expect(rawTextPaths("work", "https://github.com/o/r/issues/1", "https://github.com/o/r/issues/2")).toBeNull();
    expect(rawTextPaths("work", "https://github.com/../r/issues/1", "https://github.com/../r/pull/2")).toBeNull();
    expect(rawTextPaths("work", "javascript:alert(1)", "https://github.com/o/r/pull/2")).toBeNull();
    expect(rawTextPaths("work", "https://github.com/o/r/issues/1", "https://github.com/p/r/pull/2")).toBeNull();
  });

  it("stays inside the work folder", () => {
    const paths = rawTextPaths("work", "https://github.com/a.b_c-d/e.f_g-h/issues/1", "https://github.com/a.b_c-d/e.f_g-h/pull/2");
    expect(paths).not.toBeNull();
    for (const file of [paths!.issue, paths!.fix]) expect(path.relative("work", file).startsWith("..")).toBe(false);
  });

  it("uses a git-ignored folder by default", () => {
    expect(WORK_DIR).toBe(".import-work");
    expect(readFileSync(path.join(repo, ".gitignore"), "utf8")).toMatch(/^\/?\.import-work\/?$/m);
  });
});

describe("parseCheckArgs", () => {
  it("defaults to the repository folders", () => {
    expect(parseCheckArgs([])).toEqual({ files: [], dir: "data/imports", workDir: ".import-work" });
  });

  it("takes files, --dir and --work", () => {
    expect(parseCheckArgs(["a.json", "--work", "w", "b.json", "--dir", "d"])).toEqual({ files: ["a.json", "b.json"], dir: "d", workDir: "w" });
  });

  it("refuses an unknown flag and a flag without a value", () => {
    expect(() => parseCheckArgs(["--apply"])).toThrow(/Usage/);
    expect(() => parseCheckArgs(["--work"])).toThrow(/Usage/);
    expect(() => parseCheckArgs(["--dir"])).toThrow(/Usage/);
  });
});

describe("resolveManifestFiles", () => {
  it("uses the given files as they are", async () => {
    expect(await resolveManifestFiles({ files: ["x.json", "y.json"], dir: "nowhere", workDir: "w" })).toEqual(["x.json", "y.json"]);
  });

  it("lists the .json files of the folder in name order when no file is given", async () => {
    const dir = temp();
    manifest(dir, "b.json", []);
    manifest(dir, "a.json", []);
    manifest(dir, "notes.txt", "x");
    expect(await resolveManifestFiles({ files: [], dir, workDir: "w" })).toEqual([path.join(dir, "a.json"), path.join(dir, "b.json")]);
  });

  it("gives an empty list when the folder does not exist", async () => {
    expect(await resolveManifestFiles({ files: [], dir: path.join(temp(), "missing"), workDir: "w" })).toEqual([]);
  });
});

describe("checkManifests", () => {
  it("passes a good file, counting entries it cannot check as unchecked", async () => {
    const dir = temp();
    const file = manifest(dir, "a.json", [entryFor(1), entryFor(2), entryFor(3)]);
    const report = await checkManifests([file], { workDir: path.join(dir, "work") });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.valid).toBe(3);
    expect(report.checked).toBe(0);
    expect(report.unchecked).toEqual([
      { file, position: 1, issue: 1 },
      { file, position: 2, issue: 2 },
      { file, position: 3, issue: 3 },
    ]);
  });

  it("checks an entry when both source texts are cached, and passes it when nothing is copied", async () => {
    const dir = temp();
    const work = path.join(dir, "work");
    const entry = entryFor(7);
    cache(work, entry, UNRELATED, UNRELATED);
    const report = await checkManifests([manifest(dir, "a.json", [entry])], { workDir: work });
    expect(report).toMatchObject({ ok: true, valid: 1, checked: 1, unchecked: [] });
  });

  it("fails an entry that copies ten words from the issue, and names the fields only", async () => {
    const dir = temp();
    const work = path.join(dir, "work");
    const entry = entryFor(8);
    cache(work, entry, `Report. ${entry.summary} Thanks.`, UNRELATED);
    const file = manifest(dir, "a.json", [entry]);
    const report = await checkManifests([file], { workDir: work });
    expect(report.ok).toBe(false);
    expect(report.checked).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ file, position: 1, issue: 8 });
    expect(report.findings[0].rule).toMatch(new RegExp(`^paraphrase: summary share ${IMPORT.paraphraseRun} or more words`));
  });

  it("fails an entry that copies from the fix description", async () => {
    const dir = temp();
    const work = path.join(dir, "work");
    const entry = entryFor(9);
    cache(work, entry, UNRELATED, `The change. ${entry.fixChange}`);
    const report = await checkManifests([manifest(dir, "a.json", [entry])], { workDir: work });
    expect(report.ok).toBe(false);
    expect(report.findings[0].rule).toMatch(/^paraphrase: fixChange /);
  });

  it("treats an entry with only one cached text as unchecked, never as checked", async () => {
    const dir = temp();
    const work = path.join(dir, "work");
    const entry = entryFor(10);
    cache(work, entry, entry.summary, null);
    const report = await checkManifests([manifest(dir, "a.json", [entry])], { workDir: work });
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(0);
    expect(report.unchecked).toHaveLength(1);
  });

  it("keeps checked and unchecked in step with the valid entries", async () => {
    const dir = temp();
    const work = path.join(dir, "work");
    cache(work, entryFor(1), UNRELATED, UNRELATED);
    const report = await checkManifests([manifest(dir, "a.json", [entryFor(1), entryFor(2)])], { workDir: work });
    expect(report.valid).toBe(2);
    expect(report.checked + report.unchecked.length).toBe(report.valid);
  });

  it("reports a bad entry by file, position and issue, and counts none of that file as valid", async () => {
    const dir = temp();
    const file = manifest(dir, "a.json", [entryFor(1), entryFor(2, { title: "" }), entryFor(3)]);
    const report = await checkManifests([file], { workDir: path.join(dir, "work") });
    expect(report.ok).toBe(false);
    expect(report.valid).toBe(0);
    expect(report.findings).toEqual([{ file, position: 2, issue: 2, rule: "title: must not be empty" }]);
  });

  it("reports a problem with the whole list as one finding without a position", async () => {
    const dir = temp();
    const file = manifest(dir, "a.json", { not: "a list" });
    const report = await checkManifests([file], { workDir: path.join(dir, "work") });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ file, position: null, issue: null });
    expect(report.findings[0].rule).toMatch(/^form: /);
  });

  it("fails when two files import the same issue, naming the other file", async () => {
    const dir = temp();
    const first = manifest(dir, "a.json", [entryFor(1), entryFor(2)]);
    const second = manifest(dir, "b.json", [entryFor(3), entryFor(2, { title: "Another title for the same issue" })]);
    const report = await checkManifests([first, second], { workDir: path.join(dir, "work") });
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ file: second, position: 2, issue: 2 });
    expect(report.findings[0].rule).toBe(`issueUrl: duplicate of ${first} entry 2`);
    expect(report.valid).toBe(3);
  });

  it("fails when the same file is given twice", async () => {
    const dir = temp();
    const file = manifest(dir, "a.json", [entryFor(1)]);
    const report = await checkManifests([file, file], { workDir: path.join(dir, "work") });
    expect(report.ok).toBe(false);
    expect(report.findings[0].rule).toMatch(/^issueUrl: duplicate of /);
  });

  it("fails for a file that is not valid JSON, without the parser's message", async () => {
    const dir = temp();
    const file = manifest(dir, "a.json", `${MARKER} {{{ not json`);
    const report = await checkManifests([file], { workDir: path.join(dir, "work") });
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([{ file, position: null, issue: null, rule: "file: not valid JSON" }]);
  });

  it("fails for a file that cannot be read", async () => {
    const dir = temp();
    const file = path.join(dir, "missing.json");
    const report = await checkManifests([file], { workDir: path.join(dir, "work") });
    expect(report.findings).toEqual([{ file, position: null, issue: null, rule: "file: cannot be read" }]);
  });

  it("reads a file that starts with a byte order mark", async () => {
    const dir = temp();
    const file = manifest(dir, "a.json", `﻿${JSON.stringify([entryFor(1)])}`);
    const report = await checkManifests([file], { workDir: path.join(dir, "work") });
    expect(report.ok).toBe(true);
    expect(report.valid).toBe(1);
  });

  it("keeps going after a bad file and reports the others", async () => {
    const dir = temp();
    const bad = manifest(dir, "bad.json", "nope");
    const good = manifest(dir, "good.json", [entryFor(1)]);
    const report = await checkManifests([bad, good], { workDir: path.join(dir, "work") });
    expect(report.ok).toBe(false);
    expect(report.valid).toBe(1);
  });

  it("passes with no files at all, and says so", async () => {
    const report = await checkManifests([], { workDir: "work" });
    expect(report).toMatchObject({ ok: true, files: 0, valid: 0, checked: 0, unchecked: [], findings: [] });
  });
});

describe("formatCheckReport", () => {
  it("ends with OK, and says how many entries were checked and unchecked", async () => {
    const dir = temp();
    const file = manifest(dir, "a.json", [entryFor(41), entryFor(42)]);
    const text = formatCheckReport(await checkManifests([file], { workDir: path.join(dir, "work") }));
    const lines = text.trim().split("\n");
    expect(lines.at(-1)).toBe("OK");
    expect(text).toMatch(/\bchecked=0\b/);
    expect(text).toMatch(/\bunchecked=2\b/);
    expect(text).toMatch(/\bvalid=2\b/);
    expect(text).toContain("issue 41");
    expect(text).toContain("issue 42");
  });

  it("lists each finding and ends with FAIL", async () => {
    const dir = temp();
    const file = manifest(dir, "a.json", [entryFor(51, { title: "" })]);
    const text = formatCheckReport(await checkManifests([file], { workDir: path.join(dir, "work") }));
    expect(text).toContain(file);
    expect(text).toContain("entry 1 (issue 51): title: must not be empty");
    expect(text.trim().split("\n").at(-1)).toBe("FAIL");
  });
});

describe("the command", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/import-seeds/check.ts", ...args], { cwd: repo, encoding: "utf8" });

  it("is wired into package.json", () => {
    const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["import:check"]).toMatch(/scripts\/import-seeds\/check\.ts/);
  });

  it("exits 0 and prints OK for a good file", () => {
    const dir = temp();
    const result = run("--work", path.join(dir, "work"), manifest(dir, "a.json", [entryFor(1), entryFor(2)]));
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n").at(-1)).toBe("OK");
    expect(result.stdout).toMatch(/\bunchecked=2\b/);
  }, 60_000);

  it("exits 0 for a folder with no manifests, and says there were none", () => {
    const dir = temp();
    const result = run("--dir", path.join(dir, "none"), "--work", path.join(dir, "work"));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\bfiles=0\b/);
  }, 60_000);

  it("exits 1 for a bad entry, a duplicate across files, an unreadable file, bad JSON and a copy", () => {
    const dir = temp();
    const work = path.join(dir, "work");
    const copied = entryFor(9);
    cache(work, copied, copied.summary, UNRELATED);
    const cases: string[][] = [
      [manifest(dir, "bad-entry.json", [entryFor(1, { title: "" })])],
      [manifest(dir, "one.json", [entryFor(2)]), manifest(dir, "two.json", [entryFor(2)])],
      [path.join(dir, "missing.json")],
      [manifest(dir, "bad-json.json", "{{{")],
      [manifest(dir, "copy.json", [copied])],
    ];
    for (const files of cases) expect(run("--work", work, ...files).status).toBe(1);
  }, 120_000);

  it("exits non-zero for an unknown flag", () => {
    const result = run("--apply");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Usage/);
  }, 60_000);

  it("never prints entry text, a link, a tag or a parser message", () => {
    const dir = temp();
    const work = path.join(dir, "work");
    const copied = entryFor(9, { title: `${MARKER} agent keeps looping on the same search tool call forever` });
    cache(work, copied, `${copied.title} and more`, UNRELATED);
    const files = [
      manifest(dir, "json.json", `${MARKER} {{{`),
      manifest(dir, "entries.json", [
        goodEntry({ title: `${MARKER} ${"a".repeat(300)}`, tags: [`x-${MARKER}`], issueUrl: `https://evil.example/${MARKER}`, repository: `${MARKER}/x` }),
        { [MARKER]: MARKER },
        entryFor(3, { summary: `${MARKER} <script>alert(1)</script>` }),
      ]),
      manifest(dir, "copy.json", [copied]),
    ];
    const result = run("--work", work, ...files);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(MARKER);
  }, 60_000);
});
