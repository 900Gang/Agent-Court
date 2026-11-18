import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/config/env";

// N10 Task 5 (AC-1006): ALERT_EMAIL is optional, must be an address, and needs the email settings.

const base = {
  DATABASE_URL: "postgresql://app:pw-app-123@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
  DATABASE_URL_DIRECT: "postgresql://owner:pw-owner-456@ep-x.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
  BETTER_AUTH_SECRET: "s3cr3t-value-".repeat(4),
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_CLIENT_ID: "Ov23liExampleClientId",
  GITHUB_CLIENT_SECRET: "gh-client-secret-value-0123456789",
  APP_ENV: "development",
};
const mail = { RESEND_API_KEY: "re_test_key_value_0123456789", EMAIL_FROM: "Agent-Court <court@example.test>" };

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected function to throw");
}

describe("ALERT_EMAIL", () => {
  it("is optional, and the answer is null", () => {
    expect(parseServerEnv(base).alertEmail).toBeNull();
    expect(parseServerEnv({ ...base, ...mail }).alertEmail).toBeNull();
  });

  it("treats an empty value like an absent one", () => {
    expect(parseServerEnv({ ...base, ALERT_EMAIL: "" }).alertEmail).toBeNull();
  });

  it("is read when the email settings are there", () => {
    expect(parseServerEnv({ ...base, ...mail, ALERT_EMAIL: "ops@example.test" }).alertEmail).toBe("ops@example.test");
  });

  it.each(["not-an-address", "ops@", "@example.test", "two@@example.test", "ops@example"])("refuses %s", (value) => {
    expect(() => parseServerEnv({ ...base, ...mail, ALERT_EMAIL: value })).toThrow();
  });

  it("refuses an address with no email settings, and names the variable and the reason only", () => {
    const message = thrownMessage(() => parseServerEnv({ ...base, ALERT_EMAIL: "ops@example.test" }));
    expect(message).toContain("ALERT_EMAIL");
    expect(message).toContain("needs RESEND_API_KEY and EMAIL_FROM");
    expect(message).not.toContain("ops@example.test");
  });

  it("refuses an address with only half of the email settings", () => {
    expect(() => parseServerEnv({ ...base, RESEND_API_KEY: mail.RESEND_API_KEY, ALERT_EMAIL: "ops@example.test" })).toThrow();
    expect(() => parseServerEnv({ ...base, EMAIL_FROM: mail.EMAIL_FROM, ALERT_EMAIL: "ops@example.test" })).toThrow();
  });
});
