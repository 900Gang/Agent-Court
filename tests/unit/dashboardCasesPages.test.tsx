import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Operator } from "@/db/schema";
import type { OperatorCaseRow, VerdictFormView } from "@/lib/services/operatorCaseService";

vi.mock("@/lib/dashboard/data", () => ({ loadOperatorCases: vi.fn(), loadVerdictForm: vi.fn() }));
vi.mock("@/lib/dashboard/guard", () => ({ requireActiveOperator: vi.fn() }));
vi.mock("@/app/dashboard/cases/actions", () => ({ issueVerdictAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import VerdictPage from "@/app/dashboard/cases/[id]/verdict/page";
import CasesPage from "@/app/dashboard/cases/page";
import * as data from "@/lib/dashboard/data";
import * as guard from "@/lib/dashboard/guard";

const loadOperatorCases = vi.mocked(data.loadOperatorCases);
const loadVerdictForm = vi.mocked(data.loadVerdictForm);
const requireActiveOperator = vi.mocked(guard.requireActiveOperator);

const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(1)">[x](javascript:alert(1)) "q" & \u202Eevil';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = new Date("2026-10-28T12:00:00.000Z");
const DAY = 86_400_000;
const OPERATOR = { id: uuid(500), displayName: "Ada Lovelace", email: "ada@example.com", status: "active" } as unknown as Operator;
const ALLOWED_LINK = /^(?:\/dashboard(?:\/cases)?|\/dashboard\/cases\/[0-9a-f-]{36}\/verdict|\/dashboard\/agents\/new)$/;

const withoutReactScript = (markup: string) => markup.replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/, "");
const render = (ui: ReactNode) => withoutReactScript(renderToStaticMarkup(ui));
const text = (markup: string) => markup.replace(/<[^>]+>/g, "");
const rowsOf = (markup: string) =>
  [...markup.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) => [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => text(cell[1]).trim()));

function expectSafe(markup: string) {
  expect(markup).not.toMatch(/<script/i);
  expect(markup).not.toMatch(/<img/i);
  expect(markup.replace(/="[^"]*"/g, '=""')).not.toMatch(/<[^>]*\sonerror\s*=/i);
  for (const match of markup.matchAll(/href="([^"]*)"/g)) expect(match[1], `link ${match[1]}`).toMatch(ALLOWED_LINK);
}

const caseRow = (over: Partial<OperatorCaseRow> = {}): OperatorCaseRow => ({
  id: uuid(7),
  title: "Retry loop never stops",
  status: "open",
  agentHandle: "scribe-01",
  createdAt: new Date("2026-10-20T10:00:00Z"),
  argumentCount: 2,
  oldestArgumentAt: new Date(NOW.getTime() - 3 * DAY),
  verdict: null,
  ...over,
});

const listing = (over: Partial<Awaited<ReturnType<typeof data.loadOperatorCases>>> = {}) => ({
  cases: [caseRow()],
  agents: [{ id: uuid(3), handle: "scribe-01", points: 30, pending: 40, tier: 1 as const }],
  ...over,
});

const formView = (over: Partial<VerdictFormView> = {}): VerdictFormView => ({
  caseId: uuid(7),
  title: "Retry loop never stops",
  arguments: [
    { id: uuid(21), authorHandle: "agent-one", reasoning: "The loop has no exit.", proposedChange: "Set max_retries to 1.", createdAt: new Date("2026-10-21T10:00:00Z") },
    { id: uuid(22), authorHandle: "agent-two", reasoning: "A second view.", proposedChange: "Add a timeout.", createdAt: new Date("2026-10-22T10:00:00Z") },
  ],
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  requireActiveOperator.mockResolvedValue(OPERATOR);
  loadOperatorCases.mockResolvedValue(listing());
  loadVerdictForm.mockResolvedValue(formView());
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const casesPage = async (search: { error?: string; verdict?: string } = {}) => render(await CasesPage({ searchParams: Promise.resolve(search) }));

describe("the cases page", () => {
  it("loads the cases of the signed-in operator, never an id from the address", async () => {
    await casesPage({ error: uuid(1), verdict: uuid(2) });
    expect(loadOperatorCases).toHaveBeenCalledTimes(1);
    expect(loadOperatorCases).toHaveBeenCalledWith(OPERATOR.id);
  });

  it("has fixed panel titles", async () => {
    loadOperatorCases.mockResolvedValue(listing({ cases: [caseRow({ title: HOSTILE })] }));
    const body = text(await casesPage());
    expect(body).toContain("AGENT REPUTATION");
    expect(body).toContain("YOUR CASES");
  });

  it("shows each agent's tier, final points and pending points in separate columns", async () => {
    const rows = rowsOf(await casesPage());
    expect(rows).toContainEqual(["HANDLE", "TIER", "FINAL POINTS", "PENDING POINTS"]);
    expect(rows).toContainEqual(["scribe-01", "1", "30", "40"]);
  });

  it("explains when pending points become final", async () => {
    expect(text(await casesPage())).toContain("Pending points become final after 7 days.");
  });

  it("shows each case with title, agent, state, arguments, age and the action", async () => {
    const rows = rowsOf(await casesPage());
    expect(rows).toContainEqual(["TITLE", "AGENT", "STATE", "ARGUMENTS", "OLDEST ARGUMENT", ""]);
    expect(rows).toContainEqual(["Retry loop never stops", "scribe-01", "OPEN", "2", "3 days", "CHOOSE WINNER"]);
    expect(await casesPage()).toContain(`href="/dashboard/cases/${uuid(7)}/verdict"`);
  });

  it("says so when there are no cases or no agents", async () => {
    loadOperatorCases.mockResolvedValue({ cases: [], agents: [] });
    const body = text(await casesPage());
    expect(body).toContain("No cases yet.");
    expect(body).toContain("No agents yet.");
  });

  it("shows hostile titles, handles and states as text with only dashboard links", async () => {
    loadOperatorCases.mockResolvedValue(listing({ cases: [caseRow({ title: HOSTILE, agentHandle: HOSTILE })], agents: [{ id: uuid(3), handle: HOSTILE, points: 0, pending: 0, tier: 0 }] }));
    const markup = await casesPage();
    expectSafe(markup);
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows no operator id and no email", async () => {
    const markup = await casesPage();
    expect(markup).not.toContain(OPERATOR.id);
    expect(markup).not.toContain("ada@example.com");
  });

  it("says a verdict was recorded, and that points are pending, for a confirmed verdict", async () => {
    const body = text(await casesPage({ verdict: "ok" }));
    expect(body).toContain("Verdict recorded.");
    expect(body).toContain("pending for 7 days");
  });

  it("says a self-resolved verdict gave no points", async () => {
    const body = text(await casesPage({ verdict: "self_resolved" }));
    expect(body).toContain("Verdict recorded.");
    expect(body).toContain("no points");
    expect(body).not.toContain("pending for 7 days");
  });

  it("shows no notice for any other verdict word and never echoes it", async () => {
    const markup = await casesPage({ verdict: HOSTILE });
    expect(markup).not.toContain("Verdict recorded.");
    expect(markup).not.toContain("alert(1)");
  });

  it("shows a fixed message for an error code and never echoes an unknown one", async () => {
    expect(text(await casesPage({ error: "case_not_found" }))).toContain("ERR_CASE_NOT_FOUND");
    const hostile = await casesPage({ error: HOSTILE });
    expect(text(hostile)).toContain("ERR_UNEXPECTED_ERROR");
    expect(hostile).not.toContain("alert(1)");
  });
});

describe("the verdict page", () => {
  const verdictPage = async (id = uuid(7), search: { error?: string } = {}) =>
    render(await VerdictPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(search) }));

  it("loads the form for the signed-in operator and the case in the address", async () => {
    await verdictPage(uuid(7));
    expect(loadVerdictForm).toHaveBeenCalledWith(OPERATOR.id, uuid(7));
  });

  it("is the not-found page when there is no such case for this operator", async () => {
    loadVerdictForm.mockResolvedValue(null);
    await expect(verdictPage(uuid(8))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows the case title, one radio per argument and the warning", async () => {
    const markup = await verdictPage();
    const body = text(markup);
    expect(body).toContain("Retry loop never stops");
    expect(body).toContain("The loop has no exit.");
    expect(body).toContain("A second view.");
    expect(body).toContain("The choice is final unless appealed within 7 days.");
    expect((markup.match(/type="radio"/g) ?? []).length).toBe(2);
    expect(markup).toContain(`value="${uuid(7)}"`);
  });

  it("links back to the cases list", async () => {
    expect(await verdictPage()).toContain('href="/dashboard/cases"');
  });

  it("shows hostile text as text", async () => {
    loadVerdictForm.mockResolvedValue(formView({ title: HOSTILE, arguments: [{ id: uuid(21), authorHandle: HOSTILE, reasoning: HOSTILE, proposedChange: HOSTILE, createdAt: NOW }] }));
    const markup = await verdictPage();
    expectSafe(markup);
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows a fixed message for an error code and never echoes an unknown one", async () => {
    expect(text(await verdictPage(uuid(7), { error: "winner_not_eligible" }))).toContain("ERR_WINNER_NOT_ELIGIBLE");
    const hostile = await verdictPage(uuid(7), { error: HOSTILE });
    expect(text(hostile)).toContain("ERR_UNEXPECTED_ERROR");
    expect(hostile).not.toContain("alert(1)");
  });

  it("shows no operator id and no email", async () => {
    const markup = await verdictPage();
    expect(markup).not.toContain(OPERATOR.id);
    expect(markup).not.toContain("ada@example.com");
  });
});
