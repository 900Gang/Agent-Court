import { z } from "zod";
import { IMPORT, IMPORT_TAGS, LIMITS, REPUTATION } from "@/lib/config/constants";
import { detailFromIssues, requiredText } from "@/lib/schemas/fields";
import { fail, ok, type ServiceResult } from "@/lib/services/result";
import { licenseOf, parseGithubUrl } from "./sources";

// A tag-like piece of markup: "<" followed by a letter, "/", "!" or "?" and a later ">". A bare "a < b" is not markup.
const RAW_HTML = /<[/A-Za-z!?][^>]*>/;

/** Plain text for a manifest field: the case rules for control characters and length, and no raw HTML. */
function plainText(max: number) {
  return requiredText(max).refine((value) => !RAW_HTML.test(value), { error: "must not contain HTML" });
}

/** The longest manifest note: 200 characters are left for a newline and the link to the fix. */
export const NOTE_MAX = REPUTATION.maxNote - 200;

const needsText ={ error: (issue: { input?: unknown }) => (issue.input === undefined ? "is required" : "must be text") };

const tagsSchema = z
  .array(
    z
      .string({ error: "must be text" })
      .refine((tag) => (IMPORT_TAGS as readonly string[]).includes(tag), { error: "use only tags from the fixed list" }),
    { error: (issue) => (issue.input === undefined ? "is required" : "must be a list") },
  )
  .min(1, "at least one tag")
  .max(LIMITS.tagsPerCase, `at most ${LIMITS.tagsPerCase} tags`)
  .refine((tags) => new Set(tags).size === tags.length, { error: "tags must not repeat" });

// A manifest is ours, so an unknown field is a mistake. There is no licence field: it is looked up from the source list.
const entrySchema = z.strictObject({
  repository: z.string(needsText).refine((repository) => licenseOf(repository) !== null, { error: "is not on the list of sources" }),
  issueUrl: z.string(needsText),
  fixUrl: z.string(needsText),
  title: plainText(LIMITS.title),
  summary: plainText(LIMITS.summary),
  expected: plainText(LIMITS.expectedActual),
  actual: plainText(LIMITS.expectedActual),
  tags: tagsSchema,
  framework: plainText(80),
  language: plainText(40),
  fixReasoning: plainText(LIMITS.argumentField),
  fixChange: plainText(LIMITS.argumentField),
  // The import adds the fix link on a second line, and the whole note must fit the note limit.
  note: plainText(NOTE_MAX),
});

export type ManifestEntry = z.output<typeof entrySchema> & { license: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The link must be a well-formed GitHub link of the right kind, in exactly the repository the entry names.
function linkProblem(value: unknown, kind: "issue" | "pull", repository: unknown): string | null {
  const ref = parseGithubUrl(value);
  if (!ref || ref.kind !== kind) {
    return kind === "issue" ? "must be a link to a GitHub issue" : "must be a link to a GitHub pull request";
  }
  if (typeof repository !== "string" || `${ref.owner}/${ref.repo}` !== repository) return "must be in the repository the entry names";
  return null;
}

/** Field names and short rules on failure, never the input. On success the entry with its licence attached. */
export function parseManifestEntry(raw: unknown): ServiceResult<ManifestEntry, "invalid"> {
  const parsed = entrySchema.safeParse(raw);
  const detail = parsed.success ? {} : detailFromIssues(parsed.error);
  const record = isRecord(raw) ? raw : {};
  if (isRecord(raw)) {
    for (const [field, kind] of [["issueUrl", "issue"], ["fixUrl", "pull"]] as const) {
      if (field in detail || typeof record[field] !== "string") continue;
      const problem = linkProblem(record[field], kind, record.repository);
      if (problem) detail[field] = problem;
    }
  }
  if (!parsed.success || Object.keys(detail).length > 0) return fail("invalid", detail);
  return ok({ ...parsed.data, license: licenseOf(parsed.data.repository) as string });
}

export type ManifestProblem = {
  /** 1-based position in the list, or null for a problem with the list as a whole. */
  position: number | null;
  /** The issue number, when the entry has a well-formed issue link. */
  issue: number | null;
  detail: Record<string, string>;
};

export type ManifestResult = { ok: true; value: ManifestEntry[] } | { ok: false; problems: ManifestProblem[] };

function issueNumberOf(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const ref = parseGithubUrl(raw.issueUrl);
  return ref && ref.kind === "issue" ? ref.number : null;
}

function wholeListProblem(message: string): ManifestResult {
  return { ok: false, problems: [{ position: null, issue: null, detail: { form: message } }] };
}

/** A whole batch file: a list of at most IMPORT.maxBatch entries, each valid, none repeating an issue. */
export function parseManifest(raw: unknown): ManifestResult {
  if (!Array.isArray(raw)) return wholeListProblem("must be a list of entries");
  if (raw.length === 0) return wholeListProblem("must contain at least one entry");
  if (raw.length > IMPORT.maxBatch) return wholeListProblem(`must contain at most ${IMPORT.maxBatch} entries`);

  const entries: ManifestEntry[] = [];
  const problems: ManifestProblem[] = [];
  const firstSeen = new Map<string, number>();
  raw.forEach((item, index) => {
    const position = index + 1;
    const result = parseManifestEntry(item);
    const detail: Record<string, string> = result.ok ? {} : { ...result.detail };
    const url = isRecord(item) ? item.issueUrl : undefined;
    if (typeof url === "string" && issueNumberOf(item) !== null) {
      const first = firstSeen.get(url);
      if (first === undefined) firstSeen.set(url, position);
      else detail.issueUrl = `duplicate of entry ${first}`;
    }
    if (Object.keys(detail).length > 0) problems.push({ position, issue: issueNumberOf(item), detail });
    else if (result.ok) entries.push(result.value);
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: entries };
}
