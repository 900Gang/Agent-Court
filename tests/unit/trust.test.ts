import { describe, expect, it } from "vitest";
import { evaluateTrust } from "@/lib/services/operatorService";

const now = new Date("2026-10-18T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

describe("evaluateTrust", () => {
  it("is pending when the GitHub account is 29 days old", () => {
    expect(evaluateTrust({ githubCreatedAt: daysAgo(29), emailVerified: true, now })).toBe("pending");
  });

  it("is active when the GitHub account is exactly 30 days old", () => {
    expect(evaluateTrust({ githubCreatedAt: daysAgo(30), emailVerified: true, now })).toBe("active");
  });

  it("is active for an old account with a verified email", () => {
    expect(evaluateTrust({ githubCreatedAt: daysAgo(2000), emailVerified: true, now })).toBe("active");
  });

  it("is pending when the account age is unknown", () => {
    expect(evaluateTrust({ githubCreatedAt: null, emailVerified: true, now })).toBe("pending");
  });

  it("is pending when the email is not verified, however old the account", () => {
    expect(evaluateTrust({ githubCreatedAt: daysAgo(2000), emailVerified: false, now })).toBe("pending");
  });

  it("is pending when the creation date is in the future", () => {
    expect(
      evaluateTrust({ githubCreatedAt: new Date(now.getTime() + 86_400_000), emailVerified: true, now }),
    ).toBe("pending");
  });
});