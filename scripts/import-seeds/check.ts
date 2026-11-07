import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMPORT } from "@/lib/config/constants";
import { GUARDED_FIELDS, guardParaphrase } from "@/lib/import/guard";
import { parseManifest, type ManifestEntry } from "@/lib/import/manifest";
import { parseGithubUrl } from "@/lib/import/sources";
import { rawTextPaths, WORK_DIR } from "@/lib/import/workFolder";

// Usage:
//   pnpm import:check                    checks every .json file in data/imports
//   pnpm import:check a.json b.json      checks these files
//   --work <folder>                      where the raw source text is cached (default .import-work)
//   --dir <folder>                       the folder used when no file is given (default data/imports)
// It reads and reports; it never writes. The report holds file names, positions, issue numbers and rule names, never text.
export const DEFAULT_DIR = "data/imports";
const USAGE = "Usage: pnpm import:check [--dir folder] [--work folder] [file.json ...]";

export type CheckArgs = { files: string[]; dir: string; workDir: string };
export type Finding = { file: string; position: number | null; issue: number | null; rule: string };
export type Unchecked = { file: string; position: number; issue: number | null };
export type CheckReport = {
  ok: boolean;
  files: number;
  entries: number;
  valid: number;
  checked: number;
  unchecked: Unchecked[];
  findings: Finding[];
};

export function parseCheckArgs(argv: string[]): CheckArgs {
  const args: CheckArgs = { files: [], dir: DEFAULT_DIR, workDir: WORK_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir" || arg === "--work") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
      if (arg === "--dir") args.dir = value;
      else args.workDir = value;
    } else if (arg.startsWith("--")) {
      throw new Error(USAGE);
    } else {
      args.files.push(arg);
    }
  }
  return args;
}

/** The files given, or else the .json files of the manifest folder in name order (none when the folder is missing). */
export async function resolveManifestFiles(args: CheckArgs): Promise<string[]> {
  if (args.files.length > 0) return args.files;
  try {
    const names = (await readdir(args.dir)).filter((name) => name.endsWith(".json")).sort();
    return names.map((name) => path.join(args.dir, name));
  } catch {
    return [];
  }
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export async function checkManifests(files: string[], options: { workDir: string }): Promise<CheckReport> {
  const findings: Finding[] = [];
  const loaded: Array<{ file: string; entries: ManifestEntry[] }> = [];
  let entryCount = 0;

  for (const file of files) {
    const text = await readOrNull(file);
    if (text === null) {
      findings.push({ file, position: null, issue: null, rule: "file: cannot be read" });
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      // The parser's message quotes the input, so it is never printed.
      findings.push({ file, position: null, issue: null, rule: "file: not valid JSON" });
      continue;
    }
    if (Array.isArray(data)) entryCount += data.length;
    const result = parseManifest(data);
    if (!result.ok) {
      for (const problem of result.problems) {
        for (const [field, message] of Object.entries(problem.detail)) {
          findings.push({ file, position: problem.position, issue: problem.issue, rule: `${field}: ${message}` });
        }
      }
      continue;
    }
    loaded.push({ file, entries: result.value });
  }

  // The same issue in two files (or one file given twice) would be imported twice.
  const firstSeen = new Map<string, { file: string; position: number }>();
  const valid: Array<{ file: string; position: number; entry: ManifestEntry }> = [];
  for (const { file, entries } of loaded) {
    entries.forEach((entry, index) => {
      const position = index + 1;
      const first = firstSeen.get(entry.issueUrl);
      if (first) {
        findings.push({
          file,
          position,
          issue: parseGithubUrl(entry.issueUrl)?.number ?? null,
          rule: `issueUrl: duplicate of ${first.file} entry ${first.position}`,
        });
        return;
      }
      firstSeen.set(entry.issueUrl, { file, position });
      valid.push({ file, position, entry });
    });
  }

  // The paraphrase guard runs only when both raw texts are cached. Anything else is "unchecked", never a pass.
  let checked = 0;
  const unchecked: Unchecked[] = [];
  for (const { file, position, entry } of valid) {
    const issue = parseGithubUrl(entry.issueUrl)?.number ?? null;
    const paths = rawTextPaths(options.workDir, entry.issueUrl, entry.fixUrl);
    const issueText = paths ? await readOrNull(paths.issue) : null;
    const fixText = paths ? await readOrNull(paths.fix) : null;
    if (issueText === null || fixText === null) {
      unchecked.push({ file, position, issue });
      continue;
    }
    checked++;
    const results = [guardParaphrase(entry, issueText), guardParaphrase(entry, fixText)];
    const copied = GUARDED_FIELDS.filter((field) => results.some((result) => !result.ok && result.fields.includes(field)));
    if (copied.length > 0) {
      findings.push({
        file,
        position,
        issue,
        rule: `paraphrase: ${copied.join(", ")} share ${IMPORT.paraphraseRun} or more words with the source`,
      });
    }
  }

  return { ok: findings.length === 0, files: files.length, entries: entryCount, valid: valid.length, checked, unchecked, findings };
}

export function formatCheckReport(report: CheckReport): string {
  const lines: string[] = [];
  let currentFile: string | null = null;
  for (const finding of report.findings) {
    if (finding.file !== currentFile) {
      lines.push(finding.file);
      currentFile = finding.file;
    }
    if (finding.position === null) lines.push(`  ${finding.rule}`);
    else if (finding.issue === null) lines.push(`  entry ${finding.position}: ${finding.rule}`);
    else lines.push(`  entry ${finding.position} (issue ${finding.issue}): ${finding.rule}`);
  }
  if (report.unchecked.length > 0) {
    lines.push("unchecked (no cached source text, so the paraphrase was not compared):");
    for (const item of report.unchecked) {
      lines.push(`  ${item.file} entry ${item.position}${item.issue === null ? "" : ` (issue ${item.issue})`}`);
    }
  }
  lines.push(
    `files=${report.files} entries=${report.entries} valid=${report.valid} checked=${report.checked} unchecked=${report.unchecked.length} failed=${report.findings.length}`,
  );
  lines.push(report.ok ? "OK" : "FAIL");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseCheckArgs(process.argv.slice(2));
  const files = await resolveManifestFiles(args);
  const report = await checkManifests(files, { workDir: args.workDir });
  console.log(formatCheckReport(report));
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error && error.message.startsWith("Usage") ? error.message : "import check failed");
    process.exitCode = 1;
  });
}