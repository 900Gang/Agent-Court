import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "@/db/types";
import type { SafetyGate } from "@/lib/safety/gate";
import { rescanHeld, type RescanSummary } from "@/lib/services/rescanService";

// Usage:
//   pnpm rescan:held            dry run: counts what would change, writes nothing
//   pnpm rescan:held --apply    redacts held text in place and rejects what now blocks (never publishes)
const BATCH_SIZE = 100;
const MAX_BATCHES = 1000; // a backstop: a finished run needs far fewer

/** Only `--apply` is accepted. A typo must not turn into a write, nor a write into a silent dry run. */
export function parseRescanArgs(argv: string[]): { apply: boolean } {
  if (argv.length === 0) return { apply: false };
  if (argv.length === 1 && argv[0] === "--apply") return { apply: true };
  throw new Error("Usage: pnpm rescan:held [--apply]  (a dry run unless --apply is given)");
}

/** One line of counts. Never any content. */
export function formatSummary(summary: RescanSummary): string {
  return [
    `examined=${summary.examined}`,
    `redacted=${summary.redacted}`,
    `rejected=${summary.rejected}`,
    `unchanged=${summary.unchanged}`,
    `failed=${summary.failed}`,
    `published_stale=${summary.publishedStale}`,
  ].join(" ");
}

/**
 * Loops `rescanHeld` in batches until nothing is left to examine and adds the counts up. A dry run writes nothing,
 * so it walks forward with an offset; when applying, only items the gate failed on stay in the queue, so the offset
 * skips exactly those.
 */
export async function runRescan(
  db: Database,
  gate: SafetyGate,
  apply: boolean,
  batchSize = BATCH_SIZE,
): Promise<RescanSummary> {
  const total: RescanSummary = { examined: 0, redacted: 0, rejected: 0, unchanged: 0, failed: 0, publishedStale: 0 };
  let offset = 0;
  for (let batches = 0; ; batches++) {
    if (batches >= MAX_BATCHES) throw new Error("rescan did not finish");
    const batch = await rescanHeld(db, gate, { limit: batchSize, apply, offset });
    if (batches === 0) total.publishedStale = batch.publishedStale; // public cases are never changed, so once is enough
    if (batch.examined === 0) return total;
    total.examined += batch.examined;
    total.redacted += batch.redacted;
    total.rejected += batch.rejected;
    total.unchanged += batch.unchanged;
    total.failed += batch.failed;
    offset += apply ? batch.failed : batch.examined;
  }
}

async function main(): Promise<void> {
  const { apply } = parseRescanArgs(process.argv.slice(2));
  const { getDb, closeDb } = await import("@/db/client");
  const { createGate } = await import("@/lib/safety/engine");
  try {
    const summary = await runRescan(getDb(), createGate(), apply);
    console.log(`${apply ? "applied" : "dry run"}: ${formatSummary(summary)}`);
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "rescan failed");
    process.exitCode = 1;
  });
}
