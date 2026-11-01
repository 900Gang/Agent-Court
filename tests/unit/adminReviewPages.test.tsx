import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { AppealItem } from "@/components/admin/AppealItem";
import { ReportItem } from "@/components/admin/ReportItem";
import type { AppealListItem, ReportListItem } from "@/lib/services/reviewService";

vi.mock("@/lib/admin/reviewData", () => ({ loadReports: vi.fn(), loadAppeals: vi.fn() }));
vi.mock("@/lib/auth/requireAdmin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/app/admin/actions", () => ({ moderateFormAction: vi.fn(), reportFormAction: vi.fn() }));

import AppealsPage from "@/app/admin/appeals/page";
import ReportsPage from "@/app/admin/reports/page";
import * as reviewData from "@/lib/admin/reviewData";
import * as requireAdminModule from "@/lib/auth/requireAdmin";

const loadReports = vi.mocked(reviewData.loadReports);
const loadAppeals = vi.mocked(reviewData.loadAppeals);
const requireAdmin = vi.mocked(requireAdminModule.requireAdmin);

const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(1)">[x](javascript:alert(1)) "q" & ‮evil';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = { id: uuid(900), displayName: "Admin Ada", email: "ada@example.com", role: "admin", status: "active" } as never;

const withoutReactScript = (markup: string) => markup.replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/, "");
const render = (ui: ReactNode) => withoutReactScript(renderToStaticMarkup(ui));
const text = (markup: string) => markup.replace(/<[^>]+>/g, "");
const noop = vi.fn();

function expectSafe(markup: string) {
  expect(markup).not.toMatch(/<script/i);
  expect(markup).not.toMatch(/<img/i);
  expect(markup.replace(/="[^"]*"/g, '=""')).not.toMatch(/<[^>]*\sonerror\s*=/i);
}

const hiddenValues = (markup: string, name: string) =>
  [...markup.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*>`, "g"))].map((match) => /value="([^"]*)"/.exec(match[0])?.[1]);

const reportItem = (over: Partial<ReportListItem> = {}): ReportListItem => ({
  id: uuid(1),
  createdAt: new Date("2026-10-30T12:05:00.000Z"),
  targetType: "case",
  targetId: uuid(7),
  caseId: uuid(7),
  caseTitle: "Retry loop never stops",
  caseStatus: "resolved",
  canOpenReview: true,
  reason: "This reads like an instruction to the next reader.",
  ...over,
});

const appealItem = (over: Partial<AppealListItem> = {}): AppealListItem => ({
  caseId: uuid(7),
  caseTitle: "Retry loop never stops",
  verdictId: uuid(30),
  verdictAt: new Date("2026-10-27T12:00:00.000Z"),
  origin: "appeal",
  appealReason: "The fix did not hold on the second run.",
  pendingPoints: 10,
  ...over,
});

beforeEach(() => {
  requireAdmin.mockResolvedValue(ADMIN);
  loadReports.mockResolvedValue({ reports: [reportItem()], truncated: false });
  loadAppeals.mockResolvedValue({ appeals: [appealItem()], truncated: false });
});

afterEach(() => vi.clearAllMocks());

describe("ReportItem", () => {
  const view = (item: ReportListItem = reportItem()) => render(<ReportItem item={item} action={noop} />);

  it("shows the kind, the time, the case, its state and the reason", () => {
    const body = text(view());
    expect(body).toContain("CASE");
    expect(body).toContain("2026-10-30 12:05");
    expect(body).toContain("Retry loop never stops");
    expect(body).toContain("RESOLVED");
    expect(body).toContain("This reads like an instruction to the next reader.");
  });

  it("has a form for each decision, with the report id and the decision as hidden fields", () => {
    const markup = view();
    expect(markup.match(/<form/g)).toHaveLength(3);
    expect(hiddenValues(markup, "reportId")).toEqual([uuid(1), uuid(1), uuid(1)]);
    expect(hiddenValues(markup, "decision")).toEqual(["dismiss", "reviewed", "open_review"]);
    for (const label of ["DISMISS", "MARK REVIEWED", "OPEN REVIEW"]) expect(markup).toContain(label);
  });

  it("offers no review when none can be opened", () => {
    const markup = view(reportItem({ canOpenReview: false, caseStatus: "open" }));
    expect(markup.match(/<form/g)).toHaveLength(2);
    expect(hiddenValues(markup, "decision")).toEqual(["dismiss", "reviewed"]);
    expect(markup).not.toContain("OPEN REVIEW");
  });

  it("says an argument report is about an argument", () => {
    expect(text(view(reportItem({ targetType: "argument" })))).toContain("ARGUMENT");
  });

  it("links to the public case only for a well-formed id", () => {
    expect(view()).toContain(`href="/cases/${uuid(7)}"`);
    expect(view(reportItem({ caseId: '"><script>alert(1)</script>' }))).not.toContain("<a ");
    expect(view(reportItem({ caseId: null, caseTitle: null, caseStatus: null, canOpenReview: false }))).not.toContain("<a ");
  });

  it("says when the target is gone", () => {
    expect(text(view(reportItem({ caseId: null, caseTitle: null, caseStatus: null, canOpenReview: false })))).toContain("The reported item no longer exists.");
  });

  it("shows hostile text as text", () => {
    const markup = view(reportItem({ reason: HOSTILE, caseTitle: HOSTILE }));
    expectSafe(markup);
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("AppealItem", () => {
  const view = (item: AppealListItem = appealItem()) => render(<AppealItem item={item} />);

  it("shows an appeal with its reason, the verdict date and the pending points", () => {
    const body = text(view());
    expect(body).toContain("APPEAL");
    expect(body).toContain("Retry loop never stops");
    expect(body).toContain("The verdict was issued on 2026-10-27.");
    expect(body).toContain("The fix did not hold on the second run.");
    expect(body).toContain("10 points pending");
  });

  it("says a review opened from a report has no appeal reason", () => {
    const body = text(view(appealItem({ origin: "review", appealReason: null })));
    expect(body).toContain("REVIEW");
    expect(body).toContain("Opened by an administrator from a report.");
    expect(body).not.toContain("REASON");
  });

  it("says no points are pending when none are", () => {
    expect(text(view(appealItem({ pendingPoints: 0 })))).toContain("No points are pending.");
  });

  it("has no form yet", () => {
    expect(view()).not.toContain("<form");
  });

  it("shows hostile text as text and links only a well-formed case id", () => {
    const markup = view(appealItem({ caseTitle: HOSTILE, appealReason: HOSTILE, caseId: '"><script>alert(1)</script>' }));
    expectSafe(markup);
    expect(markup).not.toContain("<a ");
  });
});

describe("the reports page", () => {
  const page = async (search: { error?: string } = {}) => render(await ReportsPage({ searchParams: Promise.resolve(search) }));

  it("checks the admin before it loads anything, and loads nothing for anyone else", async () => {
    await page();
    expect(requireAdmin.mock.invocationCallOrder[0]).toBeLessThan(loadReports.mock.invocationCallOrder[0]);
    loadReports.mockClear();
    requireAdmin.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(loadReports).not.toHaveBeenCalled();
  });

  it("shows each report with its forms, and the count", async () => {
    const markup = await page();
    const body = text(markup);
    expect(body).toContain("REPORTS");
    expect(body).toContain("Retry loop never stops");
    expect(markup.match(/<form/g)).toHaveLength(3);
  });

  it("says so when nothing is waiting, and when the list was cut", async () => {
    loadReports.mockResolvedValue({ reports: [], truncated: false });
    expect(text(await page())).toContain("No open reports.");
    loadReports.mockResolvedValue({ reports: [reportItem()], truncated: true });
    expect(text(await page())).toContain("Only the oldest reports are shown. Decide some, then reload.");
  });

  it("shows a fixed message for an error code and never echoes an unknown one", async () => {
    expect(text(await page({ error: "report_not_open" }))).toContain("ERR_REPORT_NOT_OPEN");
    const hostile = await page({ error: HOSTILE });
    expect(text(hostile)).toContain("ERR_UNEXPECTED_ERROR");
    expect(hostile).not.toContain("alert(1)");
  });

  it("shows hostile reports as text, and no admin id or email", async () => {
    loadReports.mockResolvedValue({ reports: [reportItem({ reason: HOSTILE, caseTitle: HOSTILE })], truncated: false });
    const markup = await page();
    expectSafe(markup);
    expect(markup).not.toContain(String((ADMIN as { id: string }).id));
    expect(markup).not.toContain("ada@example.com");
  });
});

describe("the appeals page", () => {
  const page = async () => render(await AppealsPage());

  it("checks the admin before it loads anything", async () => {
    await page();
    expect(requireAdmin.mock.invocationCallOrder[0]).toBeLessThan(loadAppeals.mock.invocationCallOrder[0]);
    loadAppeals.mockClear();
    requireAdmin.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(loadAppeals).not.toHaveBeenCalled();
  });

  it("shows each verdict under review", async () => {
    const body = text(await page());
    expect(body).toContain("APPEALS");
    expect(body).toContain("Retry loop never stops");
    expect(body).toContain("The fix did not hold on the second run.");
  });

  it("says so when nothing is under review, and when the list was cut", async () => {
    loadAppeals.mockResolvedValue({ appeals: [], truncated: false });
    expect(text(await page())).toContain("No verdicts are under review.");
    loadAppeals.mockResolvedValue({ appeals: [appealItem()], truncated: true });
    expect(text(await page())).toContain("Only the oldest items are shown. Decide some, then reload.");
  });
});

describe("AdminSidebar", () => {
  const view = (current?: "moderation" | "reports" | "appeals") => render(<AdminSidebar operatorName="Ada" current={current} />);

  it("links moderation, reports and appeals", () => {
    const markup = view();
    for (const [label, href] of [["MODERATION", "/admin/moderation"], ["REPORTS", "/admin/reports"], ["APPEALS", "/admin/appeals"]]) {
      expect(markup).toMatch(new RegExp(`<a[^>]*href="${href}"[^>]*>${label}`));
    }
  });

  it("marks the current page and no other, and none when none is given", () => {
    expect(view("reports")).toMatch(/<a[^>]*aria-current="page"[^>]*>REPORTS/);
    expect(view("reports").match(/aria-current="page"/g)).toHaveLength(1);
    expect(view()).not.toContain("aria-current");
  });

  it("still shows the later pages as disabled items with no link", () => {
    const markup = view();
    for (const label of ["REDACT", "KILL SWITCH"]) expect(markup).toContain(label);
    expect(markup.split('aria-disabled="true"').length - 1).toBe(2);
    expect(markup).not.toMatch(/href="[^"]*(redact|kill)/);
  });

  it("renders the operator name as text", () => {
    const markup = render(<AdminSidebar operatorName="<script>alert(1)</script>" />);
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });
});

describe("the admin review code is guarded where it is built", () => {
  const read = (file: string) => readFileSync(file, "utf8");
  const withoutImports = (source: string) => source.replace(/^import[\s\S]*?;\n/gm, "");

  it.each(["app/admin/reports/page.tsx", "app/admin/appeals/page.tsx"])("%s calls requireAdmin", (file) => {
    expect(withoutImports(read(file))).toMatch(/await requireAdmin\(\)/);
  });

  it("the report action checks the origin, then the admin, then calls the service", () => {
    const source = withoutImports(read("lib/admin/reviewCore.ts"));
    const body = source.slice(source.indexOf("export async function handleReportCore"));
    expect(body.indexOf("assertSameOrigin(")).toBeGreaterThan(-1);
    expect(body.indexOf("assertSameOrigin(")).toBeLessThan(body.indexOf("isActiveAdmin("));
    expect(body.indexOf("isActiveAdmin(")).toBeLessThan(body.indexOf("handleReport("));
  });

  it("the server action file only calls the cores", () => {
    const source = withoutImports(read("app/admin/actions.ts"));
    expect(source).toContain("handleReportCore(");
    expect(source).not.toMatch(/\b(?:handleReport|listReports|decideReview)\(/);
  });
});
