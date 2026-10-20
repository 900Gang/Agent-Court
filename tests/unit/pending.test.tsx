import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PendingNotice } from "@/components/dashboard/PendingNotice";
import { daysUntilEligible } from "@/lib/dashboard/pending";

const DAY = 86_400_000;
const now = new Date("2026-10-20T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

describe("daysUntilEligible", () => {
  it("counts the whole days left until the account is 30 days old", () => {
    expect(daysUntilEligible(ago(10), now)).toBe(20);
    expect(daysUntilEligible(ago(1), now)).toBe(29);
  });

  it("rounds a partial day up", () => {
    expect(daysUntilEligible(ago(29.5), now)).toBe(1);
  });

  it("is 0 once the account is exactly 30 days old or older", () => {
    expect(daysUntilEligible(ago(30), now)).toBe(0);
    expect(daysUntilEligible(ago(400), now)).toBe(0);
  });

  it("is null when the account age is unknown", () => {
    expect(daysUntilEligible(null, now)).toBeNull();
  });

  it("handles a creation date in the future", () => {
    expect(daysUntilEligible(new Date(now.getTime() + DAY), now)).toBe(31);
  });
});

describe("PendingNotice", () => {
  const render = (githubCreatedAt: Date | null) => renderToStaticMarkup(<PendingNotice githubCreatedAt={githubCreatedAt} now={now} />);

  it("explains the rule", () => {
    const markup = render(ago(10));
    expect(markup).toContain("PENDING VETTING");
    expect(markup).toMatch(/30 days old/);
    expect(markup).toMatch(/verified email/i);
  });

  it("says how many days are left, in the plural", () => {
    expect(render(ago(10))).toMatch(/20 days/);
  });

  it("says 1 day, not 1 days", () => {
    const markup = render(ago(29.5));
    expect(markup).toMatch(/1 day\b/);
    expect(markup).not.toMatch(/1 days/);
  });

  it("points to the email when the account is already old enough", () => {
    const markup = render(ago(400));
    expect(markup).toMatch(/verified/i);
    expect(markup).not.toMatch(/\d+ days? to go/);
  });

  it("asks to sign in again when the account age could not be read", () => {
    expect(render(null)).toMatch(/sign in again/i);
  });

  it("is a status message", () => {
    expect(render(ago(5))).toContain('role="status"');
  });
});
