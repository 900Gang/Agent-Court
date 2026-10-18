import { afterEach, describe, expect, it, vi } from "vitest";
import { getServerEnv, parseServerEnv, resetServerEnvCache } from "@/lib/config/env";

const valid = {
  DATABASE_URL:
    "postgresql://app:pw-app-123@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
  DATABASE_URL_DIRECT:
    "postgresql://owner:pw-owner-456@ep-x.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
  BETTER_AUTH_SECRET: "s3cr3t-value-".repeat(4),
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_CLIENT_ID: "Ov23liExampleClientId",
  GITHUB_CLIENT_SECRET: "gh-client-secret-value-0123456789",
  APP_ENV: "development",
};

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected function to throw");
}

describe("parseServerEnv", () => {
  it("returns a typed object for valid input", () => {
    expect(parseServerEnv(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      databaseUrlDirect: valid.DATABASE_URL_DIRECT,
      betterAuthSecret: valid.BETTER_AUTH_SECRET,
      betterAuthUrl: valid.BETTER_AUTH_URL,
      githubClientId: valid.GITHUB_CLIENT_ID,
      githubClientSecret: valid.GITHUB_CLIENT_SECRET,
      appEnv: "development",
    });
  });

  it("defaults APP_ENV to development when it is not set", () => {
    const rest: Record<string, string> = { ...valid };
    delete rest.APP_ENV;
    expect(parseServerEnv(rest).appEnv).toBe("development");
  });

  it("names every missing variable and never includes a value", () => {
    const message = thrownMessage(() => parseServerEnv({}));
    for (const name of [
      "DATABASE_URL",
      "DATABASE_URL_DIRECT",
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
    ]) {
      expect(message).toContain(name);
    }
  });

  it("does not echo a malformed value in the error", () => {
    const message = thrownMessage(() =>
      parseServerEnv({ ...valid, DATABASE_URL: "not-a-url-LEAKME123" }),
    );
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain("LEAKME123");
  });

  it("rejects a BETTER_AUTH_SECRET shorter than 32 characters", () => {
    const message = thrownMessage(() =>
      parseServerEnv({ ...valid, BETTER_AUTH_SECRET: "short-secret" }),
    );
    expect(message).toContain("BETTER_AUTH_SECRET");
    expect(message).not.toContain("short-secret");
  });

  it("rejects an unknown APP_ENV", () => {
    const message = thrownMessage(() => parseServerEnv({ ...valid, APP_ENV: "prod" }));
    expect(message).toContain("APP_ENV");
  });

  it("requires an https BETTER_AUTH_URL in production", () => {
    const message = thrownMessage(() =>
      parseServerEnv({ ...valid, APP_ENV: "production", BETTER_AUTH_URL: "http://localhost:3000" }),
    );
    expect(message).toContain("BETTER_AUTH_URL");
    expect(
      parseServerEnv({
        ...valid,
        APP_ENV: "production",
        BETTER_AUTH_URL: "https://agent-court.example",
      }).appEnv,
    ).toBe("production");
  });

  it.each([
    ["BETTER_AUTH_SECRET", valid.BETTER_AUTH_SECRET],
    ["GITHUB_CLIENT_SECRET", valid.GITHUB_CLIENT_SECRET],
    ["DATABASE_URL", valid.DATABASE_URL],
    ["DATABASE_URL_DIRECT", valid.DATABASE_URL_DIRECT],
  ])("rejects a NEXT_PUBLIC_ variable holding the value of %s", (_name, value) => {
    const message = thrownMessage(() =>
      parseServerEnv({ ...valid, NEXT_PUBLIC_LEAKED: value }),
    );
    expect(message).toContain("NEXT_PUBLIC_LEAKED");
    expect(message).not.toContain(value);
  });

  it("allows unrelated NEXT_PUBLIC_ variables", () => {
    expect(() => parseServerEnv({ ...valid, NEXT_PUBLIC_SITE_NAME: "Agent-Court" })).not.toThrow();
  });
});

describe("getServerEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerEnvCache();
  });

  it("reads process.env once and caches the result", () => {
    for (const [name, value] of Object.entries(valid)) vi.stubEnv(name, value);
    resetServerEnvCache();

    const first = getServerEnv();
    vi.stubEnv("GITHUB_CLIENT_ID", "Ov23liChangedAfterFirstRead");
    const second = getServerEnv();

    expect(second).toBe(first);
    expect(second.githubClientId).toBe(valid.GITHUB_CLIENT_ID);

    resetServerEnvCache();
    expect(getServerEnv().githubClientId).toBe("Ov23liChangedAfterFirstRead");
  });
});