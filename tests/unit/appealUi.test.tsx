import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Operator } from "@/db/schema";
import { AppealForm } from "@/components/dashboard/AppealForm";
import { CaseRow } from "@/components/dashboard/CaseRow";
import type { AppealFormView, OperatorCaseRow } from "@/lib/services/operatorCaseService";

vi.mock("@/lib/dashboard/data", () => ({ loadOperatorCases: vi.fn(), loadVerdictForm: vi.fn(), loadAppealForm: vi.fn() }));
vi.mock("@/lib/dashboard/guard", () => ({ requireActiveOperator: vi.fn() }));
vi.mock("@/app/dashboard/cases/actions", () => ({ issueVerdictAction: vi.fn(), appealAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import AppealPage from "@/app/dashboard/cases/[id]/appeal/page";
import CasesPage from "@/app/dashboard/cases/page";
import * as data from "@/lib/dashboard/data";
import * as guard from "@/lib/dashboard/guard";

const loadOperatorCases = vi.mocked(data.loadOperatorCases);
const loadAppealForm = vi.mocked(data.loadAppealForm);
const requireActiveOperator = vi.mocked(guard.requireActiveOperator);

const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(1)">[x](javascript:alert(1)) "q" & \u202Eevil';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = new Date("2026-10-28T12:00:00.000Z");
const DAY = 86_400_000;
const OPERATOR = { id: uuid(500), displayName: "Ada Lovelace", email: "ada@example.com", status: "active" } as unknown as Operator;

const withoutReactScript = (markup: string) => markup.replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/, "");
const render = (ui: ReactNode) => withoutReactScript(renderToStaticMarkup(ui));
const text = (markup: string) => markup.replace(/<[^>]+>/g, "");

function expectSafe(markup: string) {
  expect(markup).not.toMatch(/<script/i);
  expect(markup).not.toMatch(/<img/i);
  expect(markup.replace(/="[^"]*"/g, '=""')).not.toMatch(/<[^>]*\sonerror\s*=/i);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  requireActiveOperator.mockResolvedValue(OPERATOR);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AppealForm", () => {
  const action = vi.fn();
  const view = () => render(<AppealForm caseId={uuid(7)} deadline={new Date("2026-11-03T12:00:00.000Z")} action={action} />);

  it("carries the case id in the one hidden field", () => {
    const hidden = [...view().matchAll(/<input[^>]*type="hidden"[^>]*>/g)].map((match) => match[0]);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toContain('name="caseId"');
    expect(hidden[0]).toContain(`value="${uuid(7)}"`);
    expect(view().match(/<input/g)).toHaveLength(1);
  });

  it("has a required reason of 10 to 500 characters", () => {
    const textarea = /<textarea[^>]*name="reason"[^>]*>/.exec(view())?.[0] ?? "";
    expect(textarea).toMatch(/required/);
    expect(textarea).toContain('minLength="10"');
    expect(textarea).toContain('maxLength="500"');
  });

  it("says until when, that an appeal can be made once, and that an administrator decides", () => {
    const body = text(view());
    expect(body).toContain("You can appeal until 2026-11-03.");
    expect(body).toContain("An appeal can be made only once.");
    expect(body).toContain("An administrator will decide whether the verdict stands.");
    expect(body).toContain("Do not include secrets, personal data or instructions for the reader.");
  });

  it("has a submit button", () => {
    expect(view()).toMatch(/<button[^>]*type="submit"[^>]*>FILE APPEAL/);
  });
});

describe("CaseRow: the appeal", () => {
  const row = (over: Partial<OperatorCaseRow> = {}): OperatorCaseRow => ({
    id: uuid(7),
    title: "Retry loop never stops",
    status: "resolved",
    agentHandle: "scribe-01",
    createdAt: new Date("2026-10-20T10:00:00Z"),
    argumentCount: 0,
    oldestArgumentAt: null,
    verdict: { status: "active", createdAt: new Date(NOW.getTime() - DAY), appealed: false },
    ...over,
  });
  const html = (over: Partial<OperatorCaseRow> = {}) => render(<table><tbody><CaseRow row={row(over)} now={NOW} /></tbody></table>);
  const cells = (markup: string) => [...markup.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => text(match[1]).trim());

  it("offers the appeal, with its deadline, while it is possible", () => {
    const markup = html();
    expect(cells(markup)[5]).toBe("APPEAL until 2026-11-03");
    expect(markup).toContain(`href="/dashboard/cases/${uuid(7)}/appeal"`);
  });

  it("offers it at exactly seven days and not a millisecond later", () => {
    expect(cells(html({ verdict: { status: "active", createdAt: new Date(NOW.getTime() - 7 * DAY), appealed: false } }))[5]).toMatch(/^APPEAL until /);
    const late = html({ verdict: { status: "active", createdAt: new Date(NOW.getTime() - 7 * DAY - 1), appealed: false } });
    expect(cells(late)[5]).toBe("");
    expect(late).not.toContain("/appeal");
  });

  it("offers nothing once the verdict was appealed, or when there is no live verdict", () => {
    expect(cells(html({ verdict: { status: "active", createdAt: new Date(NOW.getTime() - DAY), appealed: true } }))[5]).toBe("");
    expect(cells(html({ verdict: null }))[5]).toBe("");
  });

  it("says a case under appeal is waiting for an administrator, with no link", () => {
    const markup = html({ status: "under_appeal", verdict: { status: "under_appeal", createdAt: new Date(NOW.getTime() - DAY), appealed: true } });
    expect(cells(markup)[2]).toBe("UNDER APPEAL");
    expect(cells(markup)[5]).toBe("AWAITING ADMIN");
    expect(markup).not.toContain("<a ");
  });

  it("never links an id that is not a UUID", () => {
    expect(html({ id: '"><script>alert(1)</script>' })).not.toContain("/appeal");
  });

  it("still offers the verdict form for an open case with arguments, and the appeal for no other state", () => {
    const open = html({ status: "open", argumentCount: 1, oldestArgumentAt: new Date(NOW.getTime() - DAY), verdict: null });
    expect(cells(open)[5]).toBe("CHOOSE WINNER");
    expect(open).not.toContain("/appeal");
    expect(html({ status: "withdrawn" })).not.toContain("/appeal");
  });
});

describe("the appeal page", () => {
  const view = (over: Partial<AppealFormView> = {}): AppealFormView => ({
    caseId: uuid(7),
    title: "Retry loop never stops",
    verdictAt: new Date("2026-10-27T12:00:00.000Z"),
    deadline: new Date("2026-11-03T12:00:00.000Z"),
    ...over,
  });
  const page = async (id = uuid(7), search: { error?: string } = {}) =>
    render(await AppealPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(search) }));

  beforeEach(() => loadAppealForm.mockResolvedValue(view()));

  it("loads the form for the signed-in operator and the case in the address", async () => {
    await page(uuid(9));
    expect(loadAppealForm).toHaveBeenCalledWith(OPERATOR.id, uuid(9));
  });

  it("is the not-found page when the case cannot be appealed", async () => {
    loadAppealForm.mockResolvedValue(null);
    await expect(page(uuid(8))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows the title, the verdict date and the form", async () => {
    const markup = await page();
    const body = text(markup);
    expect(body).toContain("Retry loop never stops");
    expect(body).toContain("The verdict was issued on 2026-10-27.");
    expect(body).toContain("You can appeal until 2026-11-03.");
    expect(markup).toContain('name="reason"');
    expect(markup).toContain(`value="${uuid(7)}"`);
  });

  it("links back to the cases list only", async () => {
    const markup = await page();
    expect([...markup.matchAll(/href="([^"]*)"/g)].map((match) => match[1])).toEqual(["/dashboard/cases"]);
  });

  it("shows a hostile title as text", async () => {
    loadAppealForm.mockResolvedValue(view({ title: HOSTILE }));
    const markup = await page();
    expectSafe(markup);
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows a fixed message for an error code and never echoes an unknown one", async () => {
    expect(text(await page(uuid(7), { error: "appeal_window_closed" }))).toContain("ERR_APPEAL_WINDOW_CLOSED");
    const hostile = await page(uuid(7), { error: HOSTILE });
    expect(text(hostile)).toContain("ERR_UNEXPECTED_ERROR");
    expect(hostile).not.toContain("alert(1)");
  });

  it("shows no operator id and no email", async () => {
    const markup = await page();
    expect(markup).not.toContain(OPERATOR.id);
    expect(markup).not.toContain("ada@example.com");
  });
});

describe("the cases page after an appeal", () => {
  const casesPage = async (search: { error?: string; verdict?: string; appeal?: string } = {}) =>
    render(await CasesPage({ searchParams: Promise.resolve(search) }));
  beforeEach(() => loadOperatorCases.mockResolvedValue({ cases: [], agents: [] }));

  it("says the appeal was filed, for the one fixed word", async () => {
    expect(text(await casesPage({ appeal: "ok" }))).toContain("Appeal filed. An administrator will review the verdict.");
  });

  it("shows nothing for any other word and never echoes it", async () => {
    const markup = await casesPage({ appeal: HOSTILE });
    expect(text(markup)).not.toContain("Appeal filed.");
    expect(markup).not.toContain("alert(1)");
  });
});
