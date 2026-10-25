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
      upstashUrl: null,
      upstashToken: null,
      killSwitch: false,
      apiWritesEnabled: false,
      cronSecret: null,
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
        UPSTASH_REDIS_REST_URL: "https://example-12345.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "upstash-token-value-0123456789abcdef",
        CRON_SECRET: "c".repeat(40),
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
describe("parseServerEnv: Upstash and kill switch", () => {
  const upstash = {
    UPSTASH_REDIS_REST_URL: "https://example-12345.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "upstash-token-value-0123456789abcdef",
  };
  const production = {
    ...valid,
    APP_ENV: "production",
    BETTER_AUTH_URL: "https://agent-court.example",
    CRON_SECRET: "c".repeat(40),
  };

  it("leaves the Upstash values null in development and test when they are not set", () => {
    for (const appEnv of ["development", "test"]) {
      const env = parseServerEnv({ ...valid, APP_ENV: appEnv });
      expect(env.upstashUrl).toBeNull();
      expect(env.upstashToken).toBeNull();
    }
  });

  it("reads both Upstash values when they are set", () => {
    const env = parseServerEnv({ ...valid, ...upstash });
    expect(env.upstashUrl).toBe(upstash.UPSTASH_REDIS_REST_URL);
    expect(env.upstashToken).toBe(upstash.UPSTASH_REDIS_REST_TOKEN);
  });

  it.each(["production", "staging"])("requires both Upstash values when APP_ENV is %s", (appEnv) => {
    const message = thrownMessage(() => parseServerEnv({ ...production, APP_ENV: appEnv }));
    expect(message).toContain("UPSTASH_REDIS_REST_URL");
    expect(message).toContain("UPSTASH_REDIS_REST_TOKEN");
    expect(parseServerEnv({ ...production, APP_ENV: appEnv, ...upstash }).upstashToken).toBe(
      upstash.UPSTASH_REDIS_REST_TOKEN,
    );
  });

  it("rejects one Upstash value without the other, in any environment", () => {
    const missingToken = thrownMessage(() =>
      parseServerEnv({ ...valid, UPSTASH_REDIS_REST_URL: upstash.UPSTASH_REDIS_REST_URL }),
    );
    expect(missingToken).toContain("UPSTASH_REDIS_REST_TOKEN");

    const missingUrl = thrownMessage(() =>
      parseServerEnv({ ...valid, UPSTASH_REDIS_REST_TOKEN: upstash.UPSTASH_REDIS_REST_TOKEN }),
    );
    expect(missingUrl).toContain("UPSTASH_REDIS_REST_URL");
    expect(missingUrl).not.toContain(upstash.UPSTASH_REDIS_REST_TOKEN);
  });

  it("rejects the Upstash token held in a NEXT_PUBLIC_ variable", () => {
    const message = thrownMessage(() =>
      parseServerEnv({ ...valid, ...upstash, NEXT_PUBLIC_LEAKED: upstash.UPSTASH_REDIS_REST_TOKEN }),
    );
    expect(message).toContain("NEXT_PUBLIC_LEAKED");
    expect(message).not.toContain(upstash.UPSTASH_REDIS_REST_TOKEN);
  });

  it.each(["on", "true", "1", "ON", "True"])("turns the kill switch on for %s", (value) => {
    expect(parseServerEnv({ ...valid, KILL_SWITCH: value }).killSwitch).toBe(true);
  });

  it.each(["off", "false", "0", ""])("leaves the kill switch off for %j", (value) => {
    expect(parseServerEnv({ ...valid, KILL_SWITCH: value }).killSwitch).toBe(false);
  });

  it("leaves the kill switch off when it is not set", () => {
    expect(parseServerEnv(valid).killSwitch).toBe(false);
  });

  it.each(["maybe", "onn", "yes"])("fails fast on an unrecognised KILL_SWITCH value %j", (value) => {
    expect(thrownMessage(() => parseServerEnv({ ...valid, KILL_SWITCH: value }))).toContain("KILL_SWITCH");
  });
});

describe("parseServerEnv: API writes flag", () => {
  const upstash = {
    UPSTASH_REDIS_REST_URL: "https://example-12345.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "upstash-token-value-0123456789abcdef",
  };
  const deployed = (appEnv: string) => ({
    ...valid,
    ...upstash,
    APP_ENV: appEnv,
    BETTER_AUTH_URL: "https://agent-court.example",
    CRON_SECRET: "c".repeat(40),
  });

  it.each(["on", "true", "1", "ON", "True"])("turns writes on for %s", (value) => {
    expect(parseServerEnv({ ...valid, API_WRITES_ENABLED: value }).apiWritesEnabled).toBe(true);
  });

  it.each(["off", "false", "0", ""])("leaves writes off for %j", (value) => {
    expect(parseServerEnv({ ...valid, API_WRITES_ENABLED: value }).apiWritesEnabled).toBe(false);
  });

  it("leaves writes off when the variable is not set", () => {
    expect(parseServerEnv(valid).apiWritesEnabled).toBe(false);
  });

  it.each(["maybe", "onn", "yes"])("fails fast on an unrecognised value %j", (value) => {
    expect(thrownMessage(() => parseServerEnv({ ...valid, API_WRITES_ENABLED: value }))).toContain(
      "API_WRITES_ENABLED",
    );
  });

  it.each(["development", "test"])("allows writes on when APP_ENV is %s", (appEnv) => {
    expect(parseServerEnv({ ...valid, APP_ENV: appEnv, API_WRITES_ENABLED: "on" }).apiWritesEnabled).toBe(true);
  });

  it.each(["production", "staging"])("allows writes on when APP_ENV is %s", (appEnv) => {
    expect(parseServerEnv({ ...deployed(appEnv), API_WRITES_ENABLED: "on" }).apiWritesEnabled).toBe(true);
  });

  it.each(["production", "staging"])("accepts writes off when APP_ENV is %s", (appEnv) => {
    expect(parseServerEnv({ ...deployed(appEnv), API_WRITES_ENABLED: "off" }).apiWritesEnabled).toBe(false);
    expect(parseServerEnv(deployed(appEnv)).apiWritesEnabled).toBe(false);
  });
});

describe("parseServerEnv: CRON_SECRET", () => {
  const upstash = {
    UPSTASH_REDIS_REST_URL: "https://example-12345.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "upstash-token-value-0123456789abcdef",
  };
  const deployed = (appEnv: string, extra: Record<string, string> = {}) => ({
    ...valid,
    ...upstash,
    APP_ENV: appEnv,
    BETTER_AUTH_URL: "https://agent-court.example",
    ...extra,
  });
  const secret = "c0ffee-cron-secret-value-0123456789ab";

  it.each(["development", "test"])("is optional when APP_ENV is %s", (appEnv) => {
    expect(parseServerEnv({ ...valid, APP_ENV: appEnv }).cronSecret).toBeNull();
    expect(parseServerEnv({ ...valid, APP_ENV: appEnv, CRON_SECRET: "" }).cronSecret).toBeNull();
  });

  it("is read when it is set and long enough", () => {
    expect(parseServerEnv({ ...valid, CRON_SECRET: secret }).cronSecret).toBe(secret);
    expect(parseServerEnv({ ...valid, CRON_SECRET: "x".repeat(32) }).cronSecret).toBe("x".repeat(32));
  });

  it("rejects a secret under 32 characters without echoing it", () => {
    const short = "x".repeat(31);
    const message = thrownMessage(() => parseServerEnv({ ...valid, CRON_SECRET: short }));
    expect(message).toContain("CRON_SECRET");
    expect(message).not.toContain(short);
  });

  it.each(["production", "staging"])("is required when APP_ENV is %s, and accepted when present", (appEnv) => {
    expect(thrownMessage(() => parseServerEnv(deployed(appEnv)))).toContain("CRON_SECRET");
    expect(parseServerEnv(deployed(appEnv, { CRON_SECRET: secret })).cronSecret).toBe(secret);
  });

  it("is rejected when a NEXT_PUBLIC_ variable holds it", () => {
    const message = thrownMessage(() => parseServerEnv({ ...valid, CRON_SECRET: secret, NEXT_PUBLIC_LEAKED: secret }));
    expect(message).toContain("NEXT_PUBLIC_LEAKED");
    expect(message).not.toContain(secret);
  });
});
