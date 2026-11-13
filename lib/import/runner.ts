import { eq } from "drizzle-orm";
import { agents } from "@/db/schema";
import type { Database } from "@/db/types";
import { IMPORT } from "@/lib/config/constants";
import type { SafetyGate } from "@/lib/safety/gate";
import { importCase } from "@/lib/services/importService";
import { ensureImporter } from "./identity";
import { parseManifestEntry, type ManifestEntry } from "./manifest";
import { parseGithubUrl } from "./sources";

type Rules = Record<string, string>;

/** What a run did, by position and issue number, with field names and rule names. Never any entry text. */
export type ImportReport = {
  apply: boolean;
  importer: "present" | "created" | "would_create";
  total: number;
  skippedByLimit: number;
  /** Entries that passed the schema and do not repeat an issue of the same batch. */
  valid: number;
  invalid: Array<{ position: number; issue: number | null; rules: Rules }>;
  duplicates: Array<{ position: number; issue: number | null; reason: "in_batch" | "already_imported" }>;
  refused: Array<{ position: number; issue: number | null; rules: Rules }>;
  failed: Array<{ position: number; issue: number | null }>;
  /** Entries that passed everything. The same in a rehearsal and in the real run. */
  wouldImport: number;
  /** Entries actually written: zero in a rehearsal. */
  imported: number;
  perRepository: Record<string, number>;
  warnings: string[];
  errors: string[];
};

class Rehearsal extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issueNumberOf(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const ref = parseGithubUrl(raw.issueUrl);
  return ref && ref.kind === "issue" ? ref.number : null;
}

const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;

/**
 * Imports a batch of manifest entries, or rehearses it. A rehearsal runs the very same import for every entry inside its own
 * transaction and rolls that transaction back, so it reports exactly what the real run would and writes nothing.
 * A run is refused as a whole when it is larger than IMPORT.maxBatch, or when one repository fills more than
 * IMPORT.perRepositoryShare of a batch of 20 or more: a warning in a rehearsal, an error when applying.
 */
export async function runImport(
  db: Database,
  gate: SafetyGate,
  entries: unknown[],
  options: { apply: boolean; limit?: number },
  now: Date = new Date(),
): Promise<ImportReport> {
  const { apply, limit } = options;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("limit must be a positive whole number");
  const taken = limit === undefined ? entries : entries.slice(0, limit);

  const report: ImportReport = {
    apply,
    importer: "present",
    total: taken.length,
    skippedByLimit: entries.length - taken.length,
    valid: 0,
    invalid: [],
    duplicates: [],
    refused: [],
    failed: [],
    wouldImport: 0,
    imported: 0,
    perRepository: {},
    warnings: [],
    errors: [],
  };

  const candidates: Array<{ position: number; issue: number | null; entry: ManifestEntry }> = [];
  const seen = new Set<string>();
  taken.forEach((raw, index) => {
    const position = index + 1;
    const parsed = parseManifestEntry(raw);
    if (!parsed.ok) {
      report.invalid.push({ position, issue: issueNumberOf(raw), rules: parsed.detail ?? {} });
      return;
    }
    const issue = issueNumberOf(parsed.value);
    if (seen.has(parsed.value.issueUrl)) {
      report.duplicates.push({ position, issue, reason: "in_batch" });
      return;
    }
    seen.add(parsed.value.issueUrl);
    candidates.push({ position, issue, entry: parsed.value });
    report.perRepository[parsed.value.repository] = (report.perRepository[parsed.value.repository] ?? 0) + 1;
  });
  report.valid = candidates.length;

  const problems: string[] = [];
  if (candidates.length > IMPORT.maxBatch) {
    problems.push(`batch has ${candidates.length} entries, more than ${IMPORT.maxBatch}; use --limit ${IMPORT.maxBatch}`);
  }
  if (candidates.length >= 20) {
    for (const [repository, count] of Object.entries(report.perRepository)) {
      if (count / candidates.length > IMPORT.perRepositoryShare) {
        problems.push(`repository ${repository} is ${count} of ${candidates.length} entries, over ${Math.round(IMPORT.perRepositoryShare * 100)}%`);
      }
    }
  }
  (apply ? report.errors : report.warnings).push(...problems);

  const [existing] = await db.select({ id: agents.id }).from(agents).where(eq(agents.handle, IMPORT.handle)).limit(1);
  report.importer = existing ? "present" : "would_create";
  if (apply && report.errors.length > 0) return finish(report);

  async function work(target: Database, batch: typeof candidates): Promise<void> {
    for (const { position, issue, entry } of batch) {
      let result;
      try {
        result = await importCase(target, gate, entry, now);
      } catch {
        // The reason is not kept: a database error can quote what it was writing.
        report.failed.push({ position, issue });
        continue;
      }
      if (result.ok) {
        report.wouldImport++;
        if (apply) report.imported++;
      } else if (result.error === "duplicate") {
        report.duplicates.push({ position, issue, reason: "already_imported" });
      } else if (result.error === "refused") {
        report.refused.push({ position, issue, rules: result.detail ?? {} });
      } else if (result.error === "invalid") {
        report.invalid.push({ position, issue, rules: result.detail ?? {} });
      } else {
        report.errors.push("the import account is missing or not active; nothing more was imported");
        return;
      }
    }
  }

  if (apply) {
    await ensureImporter(db);
    if (!existing) report.importer = "created";
    await work(db, candidates);
  } else {
    // One short rolled-back transaction per entry, not one long one: a long transaction over a slow connection can stall or drop.
    // Repeats inside the batch were already set aside above, so each entry sees the same database the real run would.
    for (const candidate of candidates) {
      if (report.errors.length > 0) break;
      try {
        await db.transaction(async (tx) => {
          await ensureImporter(tx);
          await work(tx, [candidate]);
          throw new Rehearsal();
        });
      } catch (error) {
        if (!(error instanceof Rehearsal)) throw error;
      }
    }
  }
  return finish(report);
}

function finish(report: ImportReport): ImportReport {
  report.invalid.sort(byPosition);
  report.duplicates.sort(byPosition);
  report.refused.sort(byPosition);
  report.failed.sort(byPosition);
  return report;
}

const entryLabel = (position: number, issue: number | null) => `entry ${position}${issue === null ? "" : ` (issue ${issue})`}`;

/** The report as text: counts, issue numbers, field and rule names. */
export function formatImportReport(report: ImportReport): string {
  const lines: string[] = [report.apply ? "import applied" : "import dry run (nothing was written)"];
  lines.push(`importer: ${report.importer}`);
  lines.push(
    `total=${report.total} skippedByLimit=${report.skippedByLimit} valid=${report.valid} invalid=${report.invalid.length} duplicates=${report.duplicates.length} refused=${report.refused.length} failed=${report.failed.length} wouldImport=${report.wouldImport} imported=${report.imported}`,
  );
  for (const [repository, count] of Object.entries(report.perRepository).sort()) lines.push(`  ${repository}: ${count}`);
  for (const item of report.invalid) {
    for (const [field, message] of Object.entries(item.rules)) lines.push(`invalid ${entryLabel(item.position, item.issue)}: ${field}: ${message}`);
  }
  for (const item of report.duplicates) lines.push(`duplicate ${entryLabel(item.position, item.issue)}: ${item.reason}`);
  for (const item of report.refused) {
    for (const [field, message] of Object.entries(item.rules)) lines.push(`refused ${entryLabel(item.position, item.issue)}: ${field}: ${message}`);
  }
  for (const item of report.failed) lines.push(`failed ${entryLabel(item.position, item.issue)}`);
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  for (const error of report.errors) lines.push(`error: ${error}`);
  lines.push(report.errors.length === 0 ? "OK" : "FAIL");
  return lines.join("\n");
}
