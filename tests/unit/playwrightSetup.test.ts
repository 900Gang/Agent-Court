import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => ({ createDb: vi.fn() }));

import { createDb } from "@/db/client";
import { runFixtures } from "../e2e/fixtures";

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");
const LOCAL_URL = "postgresql://app_server:SENTINEL_PASSWORD@localhost:5432/agentcourt";

describe("the Playwright package and scripts", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; devDependencies: Record<string, string>; dependencies: Record<string, string> };

  it("pins @playwright/test to one exact version, as a dev dependency only", () => {
    expect(pkg.devDependencies["@playwright/test"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies["@playwright/test"]).toBeUndefined();
  });

  it("is in the lock file", () => {
    expect(read("pnpm-lock.yaml")).toContain("@playwright/test");
  });

  it("has a test:e2e script that runs Playwright and a fixtures script that runs the fixtures file", () => {
    expect(pkg.scripts["test:e2e"]).toMatch(/playwright test/);
    expect(pkg.scripts["test:e2e:fixtures"]).toContain("tests/e2e/fixtures.ts");
  });

  it("keeps the unit test run free of the end-to-end specs", () => {
    expect(read("vitest.config.ts")).toContain('include: ["tests/**/*.test.{ts,tsx}"]');
    const names = readdirSync(path.resolve(process.cwd(), "tests/e2e"));
    expect(names).toContain("smoke.spec.ts");
    for (const name of names) expect(name, name).not.toMatch(/\.test\.(?:ts|tsx)$/);
  });

  it("keeps generated reports out of git and out of the linter", () => {
    const ignore = read(".gitignore");
    const lint = read("eslint.config.mjs");
    for (const folder of ["playwright-report", "test-results"]) {
      expect(ignore, folder).toContain(folder);
      expect(lint, folder).toContain(folder);
    }
  });
});

describe("playwright.config.ts", () => {
  const config = read("playwright.config.ts");

  it("has a desktop project at 1280 by 800 and a mobile project at 375 by 812", () => {
    expect(config).toMatch(/name:\s*"desktop"/);
    expect(config).toMatch(/name:\s*"mobile"/);
    for (const size of ["1280", "800", "375", "812"]) expect(config, size).toContain(size);
  });

  it("uses Chromium only", () => {
    expect(config).toMatch(/chromium|Desktop Chrome/i);
    expect(config).not.toMatch(/firefox|webkit|Desktop Safari/i);
  });

  it("runs the built app, not the dev server, and reads specs from tests/e2e", () => {
    expect(config).toMatch(/webServer/);
    expect(config).toMatch(/pnpm start|next start/);
    expect(config).not.toMatch(/next dev|pnpm dev/);
    expect(config).toContain("tests/e2e");
    expect(config).toContain("http://localhost:3000");
  });

  it("retries at most once and keeps a trace of the first retry", () => {
    expect(config).not.toMatch(/retries:\s*(?:[2-9]|\d{2,})/);
    expect(config).toMatch(/trace:\s*"on-first-retry"/);
  });
});

describe("the CI workflow", () => {
  const ci = read(".github/workflows/ci.yml");
  const start = ci.indexOf("\n  e2e:");
  const verify = start === -1 ? ci : ci.slice(0, start);
  const e2e = start === -1 ? "" : ci.slice(start);

  it("keeps the e2e job separate from the verify job, which does not run a browser", () => {
    expect(start).toBeGreaterThan(-1);
    expect(verify).toContain("\n  verify:");
    expect(verify).toContain("pnpm check:bundle");
    expect(verify).not.toMatch(/playwright/i);
  });

  it("gives the job a Postgres service with the vector extension and a health check", () => {
    expect(e2e).toContain("services:");
    expect(e2e).toContain("pgvector/pgvector");
    expect(e2e).toContain("--health-cmd");
  });

  it("migrates, gives the app role a login, loads the fixtures, builds and runs the tests, in that order", () => {
    const steps = ["pnpm db:migrate", "ALTER ROLE app_server", "pnpm test:e2e:fixtures", "pnpm build", "playwright install", "pnpm test:e2e\n"];
    const positions = steps.map((step) => e2e.indexOf(step));
    positions.forEach((position, index) => expect(position, steps[index]).toBeGreaterThan(-1));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(e2e).toContain("psql");
  });

  it("installs Chromium only, with its system packages, from the locked version", () => {
    expect(e2e).toMatch(/pnpm exec playwright install --with-deps chromium/);
    expect(e2e).toContain("pnpm install --frozen-lockfile");
  });

  it("sets APP_ENV to test and points the app at the same address the tests use", () => {
    expect(e2e).toMatch(/APP_ENV:\s*test/);
    expect(e2e).toMatch(/BETTER_AUTH_URL:\s*http:\/\/localhost:3000/);
    for (const name of [
      "DATABASE_URL",
      "DATABASE_URL_DIRECT",
      "BETTER_AUTH_SECRET",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "CRON_SECRET",
    ]) {
      expect(e2e, name).toContain(`${name}:`);
    }
  });

  it("uses no repository secret and reaches no database but its own container", () => {
    expect(ci).not.toMatch(/\$\{\{\s*secrets\./);
    for (const line of e2e.split("\n").filter((entry) => /DATABASE_URL(?:_DIRECT)?:/.test(entry))) {
      expect(line, line).toMatch(/@localhost:5432\//);
    }
  });

  it("uploads the report when the job fails", () => {
    expect(e2e).toContain("actions/upload-artifact");
    expect(e2e).toMatch(/if:\s*(?:failure\(\)|\$\{\{\s*(?:failure\(\)|!cancelled\(\))\s*\}\})/);
    expect(e2e).toContain("playwright-report");
  });

  it("has a time limit", () => {
    expect(e2e).toMatch(/timeout-minutes:\s*\d+/);
  });
});

describe("the smoke spec", () => {
  const spec = existsSync(path.resolve(process.cwd(), "tests/e2e/smoke.spec.ts")) ? read("tests/e2e/smoke.spec.ts") : "";

  it("exists and leaves no test skipped or focused", () => {
    expect(spec.length).toBeGreaterThan(0);
    expect(spec).not.toMatch(/\.only\(|\.skip\(|\.fixme\(/);
  });

  it("covers what AC-608 asks for", () => {
    for (const marker of [
      "E2E.hostileCaseId",
      "E2E.resolvedCaseId",
      '"dialog"',
      '"pageerror"',
      '"console"',
      "Sign in to report",
      "MENU",
      "/search",
      "Not found",
    ]) {
      expect(spec, marker).toContain(marker);
    }
  });
});

describe("the fixtures script refuses to run anywhere but a local test database", () => {
  beforeEach(() => vi.mocked(createDb).mockReset());

  it.each([["development"], ["production"], ["staging"], [""], [undefined]])("refuses APP_ENV=%j before it connects", async (appEnv) => {
    await expect(runFixtures({ APP_ENV: appEnv, DATABASE_URL: LOCAL_URL })).rejects.toThrow(/APP_ENV/);
    expect(createDb).not.toHaveBeenCalled();
  });

  it("refuses when APP_ENV is missing altogether", async () => {
    await expect(runFixtures({ DATABASE_URL: LOCAL_URL })).rejects.toThrow(/APP_ENV/);
    expect(createDb).not.toHaveBeenCalled();
  });

  it("refuses a missing database address", async () => {
    await expect(runFixtures({ APP_ENV: "test" })).rejects.toThrow(/DATABASE_URL/);
    expect(createDb).not.toHaveBeenCalled();
  });

  it.each([
    ["a hosted database", "postgresql://u:SENTINEL_PASSWORD@ep-cool-name-123.eu-central-1.aws.neon.tech/neondb?sslmode=require"],
    ["a lookalike host", "postgresql://u:SENTINEL_PASSWORD@localhost.evil.example/db"],
    ["a host with localhost in the user part", "postgresql://localhost:SENTINEL_PASSWORD@db.example.test/db"],
    ["an address that is not a URL", "SENTINEL_PASSWORD not a url"],
  ])("refuses %s, even with APP_ENV=test, and never shows the address", async (_label, url) => {
    const failure = await runFixtures({ APP_ENV: "test", DATABASE_URL: url }).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).not.toContain("SENTINEL_PASSWORD");
    expect(createDb).not.toHaveBeenCalled();
  });

  it("does not run itself when the file is imported", () => {
    expect(createDb).not.toHaveBeenCalled();
  });
});
