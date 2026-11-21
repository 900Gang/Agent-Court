import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/config/env";

// N11 Task 1 (AC-1107): INVITE_ONLY. Unset means on in production and staging, and off elsewhere. An explicit off opens
// the court. A typo stops the app, so it cannot decide who may join.

const base = {
  DATABASE_URL: "postgresql://app:pw-app-123@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
  DATABASE_URL_DIRECT: "postgresql://owner:pw-owner-456@ep-x.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
  BETTER_AUTH_SECRET: "s3cr3t-value-".repeat(4),
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_CLIENT_ID: "Ov23liExampleClientId",
  GITHUB_CLIENT_SECRET: "gh-client-secret-value-0123456789",
};
const deployed = (appEnv: "production" | "staging") => ({
  ...base,
  APP_ENV: appEnv,
  BETTER_AUTH_URL: "https://court.example.test",
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "upstash-token-value-0123456789",
  CRON_SECRET: "cron-secret-value-0123456789-abcdef",
  OPENAI_API_KEY: "sk-test-value-0123456789",
});

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected function to throw");
}

describe("INVITE_ONLY when unset", () => {
  it.each(["development", "test"])("is off in %s, so nothing existing changes", (appEnv) => {
    expect(parseServerEnv({ ...base, APP_ENV: appEnv }).inviteOnly).toBe(false);
  });

  it.each(["production", "staging"] as const)("is on in %s, so a missing value never opens the court", (appEnv) => {
    expect(parseServerEnv(deployed(appEnv)).inviteOnly).toBe(true);
  });

  it("treats an empty value like an absent one", () => {
    expect(parseServerEnv({ ...deployed("production"), INVITE_ONLY: "" }).inviteOnly).toBe(true);
    expect(parseServerEnv({ ...base, APP_ENV: "development", INVITE_ONLY: "" }).inviteOnly).toBe(false);
  });
});

describe("INVITE_ONLY when set", () => {
  it.each(["on", "ON", "true", "1"])("%s turns it on everywhere", (value) => {
    expect(parseServerEnv({ ...base, APP_ENV: "development", INVITE_ONLY: value }).inviteOnly).toBe(true);
    expect(parseServerEnv({ ...deployed("production"), INVITE_ONLY: value }).inviteOnly).toBe(true);
  });

  it.each(["off", "OFF", "false", "0"])("%s opens the court, even in production", (value) => {
    expect(parseServerEnv({ ...deployed("production"), INVITE_ONLY: value }).inviteOnly).toBe(false);
    expect(parseServerEnv({ ...deployed("staging"), INVITE_ONLY: value }).inviteOnly).toBe(false);
  });

  it.each(["yes", "of", "enabled", "2", "onn"])("refuses %s, and names the variable and the reason only", (value) => {
    const message = thrownMessage(() => parseServerEnv({ ...deployed("production"), INVITE_ONLY: value }));
    expect(message).toContain("INVITE_ONLY");
    expect(message).toContain("must be on or off");
    expect(message).not.toContain(`"${value}"`);
  });
});
