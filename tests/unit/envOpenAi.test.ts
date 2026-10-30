import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/config/env";
import { collectSecrets } from "@/scripts/check-client-bundle";

const KEY = "sk-test-SENTINEL_KEY_VALUE_0123456789";

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
});

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected function to throw");
}

describe("OPENAI_API_KEY", () => {
  it.each(["development", "test"])("is optional when APP_ENV is %s, and the answer is null", (appEnv) => {
    expect(parseServerEnv({ ...base, APP_ENV: appEnv }).openAiApiKey).toBeNull();
  });

  it("treats an empty value like an absent one, as every other variable does", () => {
    expect(parseServerEnv({ ...base, APP_ENV: "development", OPENAI_API_KEY: "" }).openAiApiKey).toBeNull();
  });

  it("is returned when it is set", () => {
    expect(parseServerEnv({ ...base, APP_ENV: "development", OPENAI_API_KEY: KEY }).openAiApiKey).toBe(KEY);
  });

  it.each(["production", "staging"] as const)("is required when APP_ENV is %s", (appEnv) => {
    const { ...env } = deployed(appEnv);
    expect(parseServerEnv({ ...env, OPENAI_API_KEY: KEY }).openAiApiKey).toBe(KEY);
    const message = thrownMessage(() => parseServerEnv(env));
    expect(message).toContain("OPENAI_API_KEY (missing)");
    expect(message).not.toContain(env.DATABASE_URL);
    expect(thrownMessage(() => parseServerEnv({ ...env, OPENAI_API_KEY: "" }))).toContain("OPENAI_API_KEY (missing)");
  });

  it("never appears in an error about another variable", () => {
    const message = thrownMessage(() => parseServerEnv({ ...base, APP_ENV: "development", BETTER_AUTH_URL: "not a url", OPENAI_API_KEY: KEY }));
    expect(message).toContain("BETTER_AUTH_URL");
    expect(message).not.toContain(KEY);
  });

  it("is refused when a public variable holds it, and the error names the variable and not the key", () => {
    const message = thrownMessage(() => parseServerEnv({ ...base, APP_ENV: "development", OPENAI_API_KEY: KEY, NEXT_PUBLIC_LEAKED: KEY }));
    expect(message).toContain("NEXT_PUBLIC_LEAKED");
    expect(message).not.toContain(KEY);
  });

  it("is one of the secrets the client bundle check looks for", () => {
    expect(collectSecrets({ ...base, OPENAI_API_KEY: KEY })).toContain(KEY);
  });
});
