import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatImportReport, runImport } from "@/lib/import/runner";
import { DEFAULT_DIR, resolveManifestFiles } from "./check";

// Usage:
//   pnpm import:seeds                      dry run over every .json file in data/imports: nothing is written
//   pnpm import:seeds --apply              writes the batch (creating the import account if it is missing)
//   --file <path> / plain paths            these files instead of the folder;  --dir <folder>  another folder
//   --limit <n>                            only the first n entries
// The report holds positions, issue numbers, field and rule names and counts. Never any entry text.
const USAGE = "Usage: pnpm import:seeds [--apply] [--limit n] [--dir folder] [--file path | path ...]  (a dry run unless --apply is given)";

export type RunArgs = { apply: boolean; limit: number | undefined; files: string[]; dir: string };

export function parseRunArgs(argv: string[]): RunArgs {
  const args: RunArgs = { apply: false, limit: undefined, files: [], dir: DEFAULT_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--limit" || arg === "--dir" || arg === "--file") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
      if (arg === "--dir") args.dir = value;
      else if (arg === "--file") args.files.push(value);
      else if (/^[1-9][0-9]{0,3}$/.test(value) && Number(value) <= 1000) args.limit = Number(value);
      else throw new Error(USAGE);
    } else if (arg.startsWith("--")) {
      throw new Error(USAGE);
    } else {
      args.files.push(arg);
    }
  }
  return args;
}

/** The entries of every file, in order, and a line per file that could not be used. A problem never quotes the file. */
export async function loadEntries(files: string[]): Promise<{ entries: unknown[]; problems: string[] }> {
  const entries: unknown[] = [];
  const problems: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      problems.push(`${file}: cannot be read`);
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      problems.push(`${file}: not valid JSON`);
      continue;
    }
    if (!Array.isArray(data)) {
      problems.push(`${file}: must be a list`);
      continue;
    }
    entries.push(...data);
  }
  return { entries, problems };
}

async function main(): Promise<void> {
  const args = parseRunArgs(process.argv.slice(2));
  const files = await resolveManifestFiles({ files: args.files, dir: args.dir, workDir: "" });
  if (files.length === 0) {
    console.error("no manifest files found");
    process.exitCode = 1;
    return;
  }
  const { entries, problems } = await loadEntries(files);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
    return;
  }
  const { getDb, closeDb } = await import("@/db/client");
  const { createGate } = await import("@/lib/safety/engine");
  try {
    const report = await runImport(getDb(), createGate(), entries, { apply: args.apply, limit: args.limit });
    console.log(formatImportReport(report));
    process.exitCode = report.errors.length > 0 ? 1 : 0;
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    // The message is not printed (a database error can quote what it was writing); the class and the SQLSTATE or network code say enough.
    const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    console.error(
      error instanceof Error && error.message.startsWith("Usage")
        ? error.message
        : `import failed (${error instanceof Error ? error.constructor.name : "unknown"}${typeof code === "string" ? `, ${code}` : ""})`,
    );
    process.exitCode = 1;
  });
}
