import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// N10 Task 5 (AC-1006): the script's command line. It refuses to run without the staging confirmation, and it never
// prints a key. The run itself is tested in tests/integration/injectionSpike.test.ts.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KEY = ["spike", "key", "value", "0123456789"].join("-");
const CRON = ["cron", "secret", "value", "0123456789", "abcdef"].join("-");

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/simulate-injection-spike.ts", ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe("simulate-injection-spike command line", () => {
  it.each([
    ["no arguments", []],
    ["no confirmation", ["--url", "https://staging.example.test"]],
    ["no address", ["--confirm-staging"]],
    ["an address that is not http", ["--url", "ftp://x.example.test", "--confirm-staging"]],
    ["a count of zero", ["--url", "https://staging.example.test", "--confirm-staging", "--count", "0"]],
    ["a count that is too high", ["--url", "https://staging.example.test", "--confirm-staging", "--count", "61"]],
    ["a count that is not a number", ["--url", "https://staging.example.test", "--confirm-staging", "--count", "many"]],
    ["an option it does not know", ["--url", "https://staging.example.test", "--confirm-staging", "--production"]],
  ])("refuses %s with the usage line and a failing exit code", (_label, args) => {
    const { code, out } = run(args, { SPIKE_API_KEY: KEY, CRON_SECRET: CRON });
    expect(code).toBe(1);
    expect(out).toContain("Usage: pnpm simulate:spike");
  });

  it("asks for both secrets by name when one is missing, and never prints a value", () => {
    const { code, out } = run(["--url", "https://staging.example.test", "--confirm-staging"], { SPIKE_API_KEY: KEY });
    expect(code).toBe(1);
    expect(out).toContain("SPIKE_API_KEY and CRON_SECRET must both be set");
    expect(out).not.toContain(KEY);
  });
});
