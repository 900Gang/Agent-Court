import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Usage: pnpm simulate:spike --url <https://staging address> --confirm-staging [--count n]
//   Needs SPIKE_API_KEY (a staging key with the cases:write scope) and CRON_SECRET (the staging one) in the environment.
//
// Files a run of cases whose summary is a known injection string, through the real API of a deployment, then calls the
// alert check once. If the flag rate crosses the alert level, the alert email is sent to the alert address. It prints
// counts only: no key, no address, no case text. Run it against staging, never against production: it creates held cases
// there. (N10, AC-1006)

const DEFAULT_COUNT = 30;
const MAX_COUNT = 60;
const USAGE = "Usage: pnpm simulate:spike --url <https://staging address> --confirm-staging [--count n]   (SPIKE_API_KEY and CRON_SECRET in the environment)";

type InjectionFixture = { field: string; text: string; expect: string };

export type SpikeOptions = {
  baseUrl: string;
  apiKey: string;
  cronSecret: string;
  count: number;
  /** Replaces fetch, so a test can answer in-process. */
  fetchImpl?: typeof fetch;
  /** Makes the idempotency keys of one run different from those of another. */
  runId?: string;
};

export type SpikeResult = {
  sent: number;
  /** How many answers had each HTTP status, for example { "201": 3, "202": 25 }. */
  byStatus: Record<string, number>;
  /** The answer of the alert check: its status and the numbers and booleans in its body. */
  health: { status: number; summary: Record<string, number | boolean> };
};

/** The injection strings that are plain prose and are expected to be flagged or blocked. */
export function loadSpikeTexts(): string[] {
  const fixtures = JSON.parse(readFileSync(new URL("../tests/fixtures/injections.json", import.meta.url), "utf8")) as InjectionFixture[];
  return fixtures.filter((fixture) => fixture.field === "prose").map((fixture) => fixture.text);
}

const numbersOnly = (value: unknown): Record<string, number | boolean> => {
  const out: Record<string, number | boolean> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" || typeof entry === "boolean") out[key] = entry;
  }
  return out;
};

/** Does the simulation. Never throws on an HTTP answer: a refusal is counted by its status. */
export async function runSpike(options: SpikeOptions): Promise<SpikeResult> {
  const call = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const texts = loadSpikeTexts();
  const runId = options.runId ?? Date.now().toString(36);
  const byStatus: Record<string, number> = {};

  for (let index = 0; index < options.count; index += 1) {
    const text = texts[index % texts.length];
    const response = await call(`${base}/api/v1/cases`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", "idempotency-key": `spike-${runId}-${index}` },
      body: JSON.stringify({
        title: `Spike test case ${index + 1}`,
        summary: text,
        expected: "The simulation files this case.",
        actual: "The simulation files this case.",
        tags: ["spike-test"],
      }),
    });
    await response.arrayBuffer().catch(() => undefined);
    byStatus[String(response.status)] = (byStatus[String(response.status)] ?? 0) + 1;
  }

  const health = await call(`${base}/api/cron/health-check`, { headers: { authorization: `Bearer ${options.cronSecret}` } });
  let body: unknown = null;
  try {
    body = await health.json();
  } catch {
    // An answer that is not JSON has no counts to show.
  }
  return { sent: options.count, byStatus, health: { status: health.status, summary: numbersOnly(body) } };
}

function parseArgs(argv: string[]): { url: string; count: number } {
  let url = "";
  let count = DEFAULT_COUNT;
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--confirm-staging") confirmed = true;
    else if (arg === "--url") url = argv[++index] ?? "";
    else if (arg === "--count") count = Number(argv[++index]);
    else throw new Error(USAGE);
  }
  if (!confirmed || !/^https?:\/\/[^\s/]+/.test(url) || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw new Error(USAGE);
  return { url, count };
}

async function main(): Promise<void> {
  const { url, count } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.SPIKE_API_KEY;
  const cronSecret = process.env.CRON_SECRET;
  if (!apiKey || !cronSecret) throw new Error("SPIKE_API_KEY and CRON_SECRET must both be set in the environment");
  const result = await runSpike({ baseUrl: url, apiKey, cronSecret, count });
  console.log(`filed ${result.sent} spike cases; answers by status: ${JSON.stringify(result.byStatus)}`);
  console.log(`alert check answered ${result.health.status}: ${JSON.stringify(result.health.summary)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    // Names and reasons only: nothing that was sent or received.
    console.error(error instanceof Error ? error.message : "failed");
    process.exitCode = 1;
  });
}
