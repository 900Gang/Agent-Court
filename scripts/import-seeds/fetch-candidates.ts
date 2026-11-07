import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { licenseOf } from "@/lib/import/sources";
import { BANNER, END_MARK, oneLine } from "@/lib/import/untrusted";
import { WORK_DIR } from "@/lib/import/workFolder";
import { ghJson, realGh, type GhRunner } from "./gh";

// Usage: pnpm import:fetch <owner/repo> [--limit n] [--work folder]
// Lists closed issues of one listed repository that have a merged fix, and saves them to <work>/candidates. Read-only:
// it makes GET calls to GitHub through gh and writes only inside the work folder. What it prints is untrusted data.
const USAGE = "Usage: pnpm import:fetch <owner/repo> [--limit n] [--work folder]";
const MIN_BODY = 300;
const MAX_AGE_DAYS = 730;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Candidate = {
  repository: string;
  issue: number;
  title: string;
  labels: string[];
  closedAt: string;
  fix: { number: number; title: string; mergedAt: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first merged pull request of the same repository that mentions the issue, or null. */
export async function findMergedFix(gh: GhRunner, repository: string, issue: number): Promise<Candidate["fix"] | null> {
  if (!Number.isInteger(issue) || issue < 1) throw new Error("issue number must be a whole number");
  const events = await ghJson(gh, `repos/${repository}/issues/${issue}/timeline?per_page=100`);
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    if (!isRecord(event) || event.event !== "cross-referenced" || !isRecord(event.source) || !isRecord(event.source.issue)) continue;
    const source = event.source.issue;
    const pull = source.pull_request;
    if (!Number.isInteger(source.number) || !isRecord(pull) || typeof pull.merged_at !== "string") continue;
    if (typeof source.repository_url !== "string" || !source.repository_url.endsWith(`/repos/${repository}`)) continue;
    return { number: source.number as number, title: oneLine(source.title, 200), mergedAt: pull.merged_at };
  }
  return null;
}

// The script's own rules. Whether the issue is about an agent problem is left to the person reading it.
function looksUseful(item: unknown, now: Date): item is Record<string, unknown> {
  if (!isRecord(item) || !Number.isInteger(item.number) || (item.number as number) < 1) return false;
  if (item.pull_request !== undefined && item.pull_request !== null) return false;
  if (item.state_reason !== "completed") return false;
  const user = item.user;
  if (!isRecord(user) || user.type === "Bot" || typeof user.login !== "string" || /\[bot\]$/i.test(user.login)) return false;
  if (typeof item.body !== "string" || item.body.length < MIN_BODY) return false;
  const letters = item.body.match(/\p{L}/gu)?.length ?? 0;
  const ascii = item.body.match(/[A-Za-z]/g)?.length ?? 0;
  if (letters === 0 || ascii / letters < 0.9) return false;
  const closed = typeof item.closed_at === "string" ? Date.parse(item.closed_at) : Number.NaN;
  return Number.isFinite(closed) && now.getTime() - closed <= MAX_AGE_DAYS * DAY_MS;
}

export async function fetchCandidates(
  gh: GhRunner,
  repository: string,
  options: { workDir?: string; limit?: number; now?: Date; maxPages?: number } = {},
): Promise<{ candidates: Candidate[]; file: string }> {
  if (licenseOf(repository) === null) throw new Error("repository is not on the list of sources");
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be a whole number from 1 to 100");
  const maxPages = options.maxPages ?? 3;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error("maxPages must be a whole number from 1 to 10");
  const now = options.now ?? new Date();
  const workDir = options.workDir ?? WORK_DIR;

  const candidates: Candidate[] = [];
  for (let page = 1; page <= maxPages && candidates.length < limit; page++) {
    const items = await ghJson(gh, `repos/${repository}/issues?state=closed&per_page=100&page=${page}&sort=updated&direction=desc`);
    if (!Array.isArray(items) || items.length === 0) break;
    for (const item of items) {
      if (candidates.length >= limit) break;
      if (!looksUseful(item, now)) continue;
      const fix = await findMergedFix(gh, repository, item.number as number);
      if (!fix) continue;
      const labels = Array.isArray(item.labels)
        ? item.labels.flatMap((label) => (isRecord(label) && typeof label.name === "string" ? [oneLine(label.name, 50)] : [])).slice(0, 10)
        : [];
      candidates.push({ repository, issue: item.number as number, title: oneLine(item.title, 200), labels, closedAt: item.closed_at as string, fix });
    }
  }

  const [owner, name] = repository.split("/");
  const file = path.join(workDir, "candidates", `${owner}__${name}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(candidates, null, 2));
  return { candidates, file };
}

export function parseFetchArgs(argv: string[]): { repository: string; limit: number | undefined; workDir: string } {
  let repository: string | undefined;
  let limit: number | undefined;
  let workDir = WORK_DIR;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit" || arg === "--work") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
      if (arg === "--work") workDir = value;
      else if (/^[1-9][0-9]{0,5}$/.test(value)) limit = Number(value);
      else throw new Error(USAGE);
    } else if (arg.startsWith("--") || repository !== undefined) {
      throw new Error(USAGE);
    } else {
      repository = arg;
    }
  }
  if (repository === undefined) throw new Error(USAGE);
  return { repository, limit, workDir };
}

/** The candidates between the banner and the end mark, one per line. Titles are cleaned, single-line, third-party text. */
export function formatCandidates(candidates: Candidate[]): string {
  const lines = candidates.length === 0 ? ["no candidates found"] : candidates.map((c) => `#${c.issue}  fix #${c.fix.number}  ${c.title}`);
  return [BANNER, ...lines, END_MARK].join("\n");
}

async function main(): Promise<void> {
  const args = parseFetchArgs(process.argv.slice(2));
  const { candidates, file } = await fetchCandidates(realGh, args.repository, { workDir: args.workDir, limit: args.limit });
  console.log(formatCandidates(candidates));
  console.log(`saved: ${file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "import fetch failed");
    process.exitCode = 1;
  });
}
