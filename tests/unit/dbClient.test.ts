import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildClientOptions,
  closeDb,
  createDb,
  getDb,
  normalizeDatabaseUrl,
} from "@/db/client";
import { resetServerEnvCache } from "@/lib/config/env";

describe("normalizeDatabaseUrl", () => {
  it("removes channel_binding and keeps sslmode", () => {
    const result = normalizeDatabaseUrl(
      "postgresql://u:p%40ss@ep-x.neon.tech/neondb?sslmode=require&channel_binding=require",
    );
    expect(result).not.toContain("channel_binding");
    expect(result).toContain("sslmode=require");
  });

  it("keeps the password exactly as written", () => {
    const result = normalizeDatabaseUrl(
      "postgresql://u:p%40ss%2Fword@ep-x.neon.tech/neondb?channel_binding=require",
    );
    expect(result).toContain("u:p%40ss%2Fword@");
  });

  it("leaves no dangling question mark when channel_binding was the only parameter", () => {
    expect(
      normalizeDatabaseUrl("postgresql://u:p@ep-x.neon.tech/neondb?channel_binding=require"),
    ).toBe("postgresql://u:p@ep-x.neon.tech/neondb");
  });

  it("returns a URL without channel_binding unchanged", () => {
    const url = "postgresql://u:p@localhost:5432/db?sslmode=disable";
    expect(normalizeDatabaseUrl(url)).toBe(url);
  });

  it("throws on an invalid URL without echoing it", () => {
    let message = "";
    try {
      normalizeDatabaseUrl("not-a-url-LEAKME123");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("LEAKME123");
  });
});

describe("buildClientOptions", () => {
  it("disables prepared statements, which PgBouncer transaction mode cannot keep", () => {
    expect(buildClientOptions("postgresql://u:p@ep-x-pooler.neon.tech/neondb").prepare).toBe(false);
  });

  it("keeps the connection pool small for serverless", () => {
    expect(buildClientOptions("postgresql://u:p@ep-x-pooler.neon.tech/neondb").max).toBeLessThanOrEqual(5);
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("does not require TLS for %s", (host) => {
    expect(buildClientOptions(`postgresql://u:p@${host}:5432/db`).ssl).toBe(false);
  });

  it("requires TLS for any other host", () => {
    expect(buildClientOptions("postgresql://u:p@ep-x-pooler.neon.tech/neondb").ssl).toBe("require");
  });
});

describe("createDb", () => {
  it("builds a client without connecting, and can be closed", async () => {
    const db = createDb("postgresql://u:p@localhost:5432/db");
    expect(typeof db.select).toBe("function");
    await db.$client.end();
  });
});

const env = {
  DATABASE_URL: "postgresql://app:pw-app-123@pooled.example.test/neondb?sslmode=require",
  DATABASE_URL_DIRECT: "postgresql://owner:pw-owner-456@direct.example.test/neondb?sslmode=require",
  BETTER_AUTH_SECRET: "s3cr3t-value-".repeat(4),
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_CLIENT_ID: "Ov23liExampleClientId",
  GITHUB_CLIENT_SECRET: "gh-client-secret-value-0123456789",
  APP_ENV: "development",
};

describe("getDb", () => {
  afterEach(async () => {
    await closeDb();
    vi.unstubAllEnvs();
    resetServerEnvCache();
  });

  function stubEnv() {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    resetServerEnvCache();
  }

  it("returns one shared instance until it is closed", async () => {
    stubEnv();
    const first = getDb();
    expect(getDb()).toBe(first);
    await closeDb();
    expect(getDb()).not.toBe(first);
  });

  it("connects through the pooled URL, never the direct one", () => {
    stubEnv();
    const options = getDb().$client.options;
    expect(JSON.stringify(options.host)).toContain("pooled.example.test");
    expect(JSON.stringify(options.host)).not.toContain("direct.example.test");
    expect(options.prepare).toBe(false);
    expect(options.max).toBeLessThanOrEqual(5);
  });
});

describe("db/client.ts", () => {
  it("imports server-only so it can never be bundled for the browser", () => {
    expect(readFileSync("db/client.ts", "utf8")).toMatch(/^import ["']server-only["'];?/m);
  });
});