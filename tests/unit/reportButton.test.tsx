import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReportButton } from "@/components/ReportButton";
import { REPORT } from "@/lib/config/constants";

const ID = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const noop = async () => {};
const html = (props: Partial<Parameters<typeof ReportButton>[0]> = {}) =>
  renderToStaticMarkup(<ReportButton signedIn targetType="case" targetId={ID} caseId={ID} action={noop} {...props} />);

const hidden = (markup: string, name: string) =>
  [...markup.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*>`, "g"))].map((match) => /value="([^"]*)"/.exec(match[0])?.[1]);

describe("ReportButton: a visitor who is not signed in", () => {
  it("is told to sign in, with a link to the dashboard, and gets no form", () => {
    const markup = html({ signedIn: false });
    expect(markup).toContain("Sign in to report");
    expect(markup).toContain('href="/dashboard"');
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("<textarea");
  });
});

describe("ReportButton: a signed-in operator", () => {
  it("gets a details block with a form that posts to the action", () => {
    const markup = html();
    expect(markup).toContain("<details");
    expect(markup).toMatch(/<summary[^>]*>[^<]*Report/);
    expect(markup).toContain("<form");
    expect(markup).toContain("<textarea");
    expect(markup).toMatch(/<button[^>]*type="submit"/);
  });

  it("names the three hidden fields and the reason", () => {
    const markup = html({ targetType: "argument", targetId: OTHER, caseId: ID });
    expect(hidden(markup, "targetType")).toEqual(["argument"]);
    expect(hidden(markup, "targetId")).toEqual([OTHER]);
    expect(hidden(markup, "caseId")).toEqual([ID]);
    expect(markup).toMatch(/<textarea[^>]*name="reason"/);
  });

  it("puts the agreed length limits on the reason, and makes it required", () => {
    const tag = /<textarea[^>]*>/.exec(html())?.[0] ?? "";
    expect(tag).toContain(`minLength="${REPORT.minReason}"`);
    expect(tag).toContain(`maxLength="${REPORT.maxReason}"`);
    expect(tag).toMatch(/required/);
  });

  it("explains that the reason is read by a person and must not hold secrets", () => {
    expect(html()).toMatch(/secret|personal/i);
  });

  it("never writes a hostile id or type into the markup unescaped", () => {
    const hostile = '"><script>alert(1)</script>';
    const raw = html({ targetId: hostile, caseId: hostile, targetType: hostile as never });
    // React adds its own form-replay script after a form with a function action; it holds no input from us.
    const start = raw.indexOf("<script>addEventListener");
    const markup = start === -1 ? raw : raw.slice(0, start);
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toMatch(/<script/i);
    expect(markup).not.toMatch(/<[^>]*\sonerror\s*=/i);
  });
});
