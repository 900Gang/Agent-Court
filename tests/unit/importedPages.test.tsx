import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Argument, Case, Evidence } from "@/db/schema";
import { CaseCard } from "@/components/CaseCard";
import { IMPORT } from "@/lib/config/constants";
import type { CaseListItem } from "@/lib/serializers/toAgentView";
import type { PublicAgentView, PublicCaseView, PublicVerdict } from "@/lib/services/observerService";

vi.mock("@/lib/observer/data", () => ({
  loadHome: vi.fn(),
  loadCase: vi.fn(),
  loadAgent: vi.fn(),
  loadSearch: vi.fn(),
  loadViewer: vi.fn(),
}));
vi.mock("@/app/(public)/actions", () => ({ reportAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import AgentPage from "@/app/(public)/agents/[handle]/page";
import CasePage from "@/app/(public)/cases/[id]/page";
import HomePage from "@/app/(public)/page";
import * as data from "@/lib/observer/data";

const loadHome = vi.mocked(data.loadHome);
const loadCase = vi.mocked(data.loadCase);
const loadAgent = vi.mocked(data.loadAgent);
const loadViewer = vi.mocked(data.loadViewer);

const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(1)">[x](javascript:alert(1)) "q" & \u202eevil';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CASE_ID = uuid(1);
const ISSUE = "https://github.com/langchain-ai/langchain/issues/1234";
const FIX = "https://github.com/langchain-ai/langchain/pull/1240";

const withoutReactScript = (markup: string) => markup.replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/, "");
const render = (ui: ReactNode) => withoutReactScript(renderToStaticMarkup(ui));
const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
const SITE_LINK = /^(?:\/|\/search(?:\?[A-Za-z0-9%=&;._~-]*)?|\/about|\/dashboard|\/terms|\/privacy|\/cases\/[0-9a-f-]{36}(?:#argument-[0-9a-f-]{36})?|\/agents\/[a-z0-9][a-z0-9-]{2,31}|#main|#argument-[0-9a-f-]{36})$/;
const outsideLinks = (markup: string) => hrefs(markup).filter((href) => !SITE_LINK.test(href));

const makeCase = (over: Partial<Case> = {}): Case =>
  ({
    id: CASE_ID,
    agentId: uuid(2),
    title: "Agent repeats the same tool call",
    summary: "A summary.",
    expected: "It stops.",
    actual: "It does not.",
    environment: { framework: "LangChain", language: "Python" },
    tags: ["loops"],
    status: "resolved",
    source: "imported",
    sourceUrl: ISSUE,
    sourceLicense: "MIT",
    createdAt: new Date("2026-10-20T10:00:00Z"),
    publishedAt: new Date("2026-10-20T10:05:00Z"),
    resolvedAt: new Date("2026-10-20T10:05:00Z"),
    ...over,
  }) as unknown as Case;

const argument = { id: uuid(20), caseId: CASE_ID, agentId: uuid(2), status: "won", reasoning: "The loop check was wrong.", proposedChange: "Compare every call.", createdAt: new Date("2026-10-20T10:05:00Z") } as unknown as Argument;
const evidence = [] as Evidence[];

const importedVerdict = (over: Partial<PublicVerdict> = {}): PublicVerdict => ({
  id: uuid(30),
  status: "active",
  decidedBy: "imported",
  verificationLevel: "imported",
  note: `Fixed upstream: langchain-ai/langchain change #1240\n${FIX}`,
  createdAt: new Date("2026-10-20T10:05:00Z"),
  winningArgumentId: uuid(20),
  ...over,
});

const view = (over: Partial<PublicCaseView> = {}): PublicCaseView => ({
  case: makeCase(),
  filedBy: { handle: IMPORT.handle },
  evidence,
  arguments: [{ argument, authorHandle: IMPORT.handle }],
  verdict: importedVerdict(),
  ...over,
});

const nativeView = (): PublicCaseView =>
  view({
    case: makeCase({ source: "native", sourceUrl: null, sourceLicense: null, status: "open", resolvedAt: null }),
    filedBy: { handle: "scribe-01" },
    verdict: null,
  });

const item = (over: Partial<Case> = {}): CaseListItem => ({ case: makeCase(over), filedBy: { handle: IMPORT.handle }, argumentCount: 1 });

const caseProps = { params: Promise.resolve({ id: CASE_ID }), searchParams: Promise.resolve({}) };

const agentView = (handle: string, over: Partial<PublicAgentView> = {}): PublicAgentView => ({
  agent: { handle, model: null, framework: null, description: "Files things.", status: "active", createdAt: new Date("2026-10-01T09:00:00Z") },
  counts: { publicCases: 1, liveArguments: 1, winningArguments: 1 },
  reputation: { points: 0, tier: 0 },
  cases: [item({ id: uuid(40) })],
  arguments: [],
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  loadViewer.mockResolvedValue({ signedIn: false, canReport: false });
  loadHome.mockResolvedValue({ resolved: [], open: [] });
  loadCase.mockResolvedValue(view());
  loadAgent.mockResolvedValue(agentView("scribe-01", { cases: [item({ source: "native", sourceUrl: null, sourceLicense: null })] }));
});

describe("the case page for an imported case", () => {
  it("shows the imported notice, with the issue and the fix as the only outside links", async () => {
    const markup = render(await CasePage(caseProps));
    const words = text(markup);
    expect(words).toContain("Imported from langchain-ai/langchain (licence MIT).");
    expect(words).toContain("Paraphrased from a public issue; not verified by this court.");
    expect(words).toContain("Imported cases earn no reputation.");
    expect(outsideLinks(markup).sort()).toEqual([FIX, ISSUE].sort());
    for (const anchor of markup.match(/<a\b[^>]*href="https:\/\/github\.com[^"]*"[^>]*>/g) ?? []) {
      expect(anchor).toContain('target="_blank"');
      expect(anchor).toContain('rel="noopener noreferrer nofollow"');
    }
  });

  it("labels the verdict as imported and decided by the import", async () => {
    const words = text(render(await CasePage(caseProps)));
    expect(words).toContain("VERDICT");
    expect(words).toContain("IMPORTED");
    expect(words).toContain("DECIDED BY IMPORTED");
    expect(words).not.toContain("OPERATOR-CONFIRMED");
  });

  it("makes the fix link from the note only when the note ends with a real pull request link", async () => {
    loadCase.mockResolvedValue(view({ verdict: importedVerdict({ note: "Fixed upstream: something\njavascript:alert(1)" }) }));
    const markup = render(await CasePage(caseProps));
    expect(outsideLinks(markup)).toEqual([ISSUE]);
    loadCase.mockResolvedValue(view({ verdict: null }));
    expect(outsideLinks(render(await CasePage(caseProps)))).toEqual([ISSUE]);
  });

  it("makes no link from hostile stored values, and shows them as text", async () => {
    loadCase.mockResolvedValue(view({ case: makeCase({ sourceUrl: "javascript:alert(1)", sourceLicense: HOSTILE }), verdict: importedVerdict({ note: HOSTILE }) }));
    const markup = render(await CasePage(caseProps));
    expect(outsideLinks(markup)).toEqual([]);
    expect(markup).not.toMatch(/<script|<img|<iframe|<style/i);
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("the case page for a native case", () => {
  it("shows no imported notice, no outside link and no imported label", async () => {
    loadCase.mockResolvedValue(nativeView());
    const markup = render(await CasePage(caseProps));
    expect(text(markup)).not.toContain("Imported from");
    expect(text(markup)).not.toContain("IMPORTED");
    expect(text(markup)).not.toContain("earn no reputation");
    expect(outsideLinks(markup)).toEqual([]);
  });

  it("shows no notice for a native case that somehow carries a link, because only source decides", async () => {
    loadCase.mockResolvedValue(view({ case: makeCase({ source: "native", sourceUrl: ISSUE, sourceLicense: "MIT" }), verdict: null }));
    const markup = render(await CasePage(caseProps));
    expect(text(markup)).not.toContain("Imported from");
    expect(outsideLinks(markup)).toEqual([]);
  });
});

describe("case cards", () => {
  it("show the imported badge for an imported case only", () => {
    expect(text(render(<CaseCard item={item()} />))).toContain("IMPORTED");
    expect(text(render(<CaseCard item={item({ source: "native", sourceUrl: null, sourceLicense: null })} />))).not.toContain("IMPORTED");
  });

  it("show it on the home page lists, and make no outside link", async () => {
    loadHome.mockResolvedValue({ resolved: [item({ id: uuid(50) })], open: [] });
    const markup = render(await HomePage());
    expect(text(markup)).toContain("IMPORTED");
    expect(outsideLinks(markup)).toEqual([]);
  });
});

describe("the profile of the import account", () => {
  it("says it is the court's import account and shows the imported label instead of a reputation", async () => {
    loadAgent.mockResolvedValue(agentView(IMPORT.handle));
    const markup = render(await AgentPage({ params: Promise.resolve({ handle: IMPORT.handle }) }));
    const words = text(markup);
    expect(words).toContain("IMPORTED");
    expect(words).toContain("This is the court's import account. Its cases are paraphrased from public issues, are labelled imported, and earn no reputation.");
    expect(words).not.toMatch(/TIER \d/);
    expect(words).not.toContain("Points count once");
  });

  it("lists its imported cases with the badge", async () => {
    loadAgent.mockResolvedValue(agentView(IMPORT.handle));
    const words = text(render(await AgentPage({ params: Promise.resolve({ handle: IMPORT.handle }) })));
    expect(words).toContain("Cases filed");
    expect(words.match(/IMPORTED/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves every other profile as it was", async () => {
    const words = text(render(await AgentPage({ params: Promise.resolve({ handle: "scribe-01" }) })));
    expect(words).toMatch(/TIER \d/);
    expect(words).toContain("Points count once");
    expect(words).not.toContain("import account");
    expect(words).not.toContain("IMPORTED");
  });
});
