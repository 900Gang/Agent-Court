import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Argument, Case, Evidence } from "@/db/schema";
import type { CaseListItem } from "@/lib/serializers/toAgentView";
import type { PublicAgentView, PublicCaseView, PublicSearch, PublicVerdict } from "@/lib/services/observerService";

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

import AboutPage, { metadata as aboutMetadata } from "@/app/(public)/about/page";
import AgentPage, { metadata as agentMetadata } from "@/app/(public)/agents/[handle]/page";
import CasePage, { generateMetadata as caseMetadata } from "@/app/(public)/cases/[id]/page";
import PublicLayout from "@/app/(public)/layout";
import NotFoundPage from "@/app/(public)/not-found";
import HomePage from "@/app/(public)/page";
import PrivacyPage, { metadata as privacyMetadata } from "@/app/(public)/privacy/page";
import SearchPage, { metadata as searchMetadata } from "@/app/(public)/search/page";
import TermsPage, { metadata as termsMetadata } from "@/app/(public)/terms/page";
import * as data from "@/lib/observer/data";

const loadHome = vi.mocked(data.loadHome);
const loadCase = vi.mocked(data.loadCase);
const loadAgent = vi.mocked(data.loadAgent);
const loadSearch = vi.mocked(data.loadSearch);
const loadViewer = vi.mocked(data.loadViewer);

const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(1)">[x](javascript:alert(1)) "q" & \u202Eevil';
const ESCAPED_SCRIPT = "&lt;script&gt;alert(1)&lt;/script&gt;";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CASE_ID = uuid(1);

const ALLOWED_LINK =
  /^(?:\/|\/search(?:\?[A-Za-z0-9%=&;._~-]*)?|\/about|\/dashboard|\/terms|\/privacy|\/cases\/[0-9a-f-]{36}(?:#argument-[0-9a-f-]{36})?|\/agents\/[a-z0-9][a-z0-9-]{2,31}|#main|#argument-[0-9a-f-]{36})$/;

// React adds its own form-replay script after a form whose action is a function. It holds nothing of ours.
const withoutReactScript = (markup: string) => markup.replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/, "");
const render = (ui: ReactNode) => withoutReactScript(renderToStaticMarkup(ui));
const text = (markup: string) => markup.replace(/<[^>]+>/g, "");
const count = (markup: string, pattern: RegExp) => (markup.match(pattern) ?? []).length;

/** No markup was made from user text, and every link goes only where the site itself goes. */
function expectSafe(markup: string) {
  expect(markup).not.toMatch(/<script/i);
  expect(markup).not.toMatch(/<img/i);
  expect(markup).not.toMatch(/<iframe|<style/i);
  // Attribute values are cut out first: an escaped value may legitimately hold the text "onerror=".
  expect(markup.replace(/="[^"]*"/g, '=""')).not.toMatch(/<[^>]*\sonerror\s*=/i);
  for (const match of markup.matchAll(/href="([^"]*)"/g)) {
    expect(match[1], `link ${match[1]}`).toMatch(ALLOWED_LINK);
  }
}

const hiddenValues = (markup: string, name: string) =>
  [...markup.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*>`, "g"))].map((match) => /value="([^"]*)"/.exec(match[0])?.[1]);

const makeCase = (over: Partial<Case> = {}): Case =>
  ({
    id: CASE_ID,
    agentId: uuid(2),
    title: "Retry loop never stops",
    summary: "The agent retries forever.",
    expected: "It stops after three tries.",
    actual: "It never stops.",
    environment: {},
    tags: ["retry"],
    status: "open",
    source: "native",
    sourceUrl: null,
    sourceLicense: null,
    createdAt: new Date("2026-10-20T10:00:00Z"),
    publishedAt: new Date("2026-10-20T10:05:00Z"),
    resolvedAt: null,
    ...over,
  }) as unknown as Case;

const makeArgument = (over: Partial<Argument> = {}): Argument =>
  ({
    id: uuid(20),
    caseId: CASE_ID,
    agentId: uuid(3),
    status: "active",
    reasoning: "The loop has no exit.",
    proposedChange: "Set max_retries to 1.",
    createdAt: new Date("2026-10-21T10:00:00Z"),
    ...over,
  }) as unknown as Argument;

const makeEvidence = (over: Partial<Evidence> = {}): Evidence =>
  ({ id: uuid(10), caseId: CASE_ID, kind: "trace", status: "active", redactedText: "step 1: call tool", createdAt: new Date("2026-10-20T10:00:00Z"), ...over }) as unknown as Evidence;

const makeVerdict = (over: Partial<PublicVerdict> = {}): PublicVerdict => ({
  id: uuid(30),
  status: "active",
  decidedBy: "operator",
  verificationLevel: "operator_confirmed",
  note: "The fix held.",
  createdAt: new Date("2026-10-22T10:00:00Z"),
  winningArgumentId: uuid(20),
  ...over,
});

const makeView = (over: Partial<PublicCaseView> = {}): PublicCaseView => ({
  case: makeCase(),
  filedBy: { handle: "scribe-01" },
  evidence: [makeEvidence()],
  arguments: [
    { argument: makeArgument(), authorHandle: "agent-one" },
    { argument: makeArgument({ id: uuid(21), reasoning: "A second view." }), authorHandle: "agent-two" },
  ],
  verdict: null,
  ...over,
});

const hostileView = (): PublicCaseView =>
  makeView({
    case: makeCase({
      title: HOSTILE,
      summary: HOSTILE,
      expected: HOSTILE,
      actual: HOSTILE,
      tags: [HOSTILE],
      environment: { model: HOSTILE, framework: HOSTILE, notes: HOSTILE, tools: [HOSTILE] },
    }),
    filedBy: { handle: HOSTILE },
    evidence: [makeEvidence({ redactedText: HOSTILE })],
    arguments: [{ argument: makeArgument({ reasoning: HOSTILE, proposedChange: HOSTILE }), authorHandle: HOSTILE }],
    verdict: makeVerdict({ note: HOSTILE }),
  });

const item = (over: Partial<Case> = {}, argumentCount = 0): CaseListItem => ({
  case: makeCase(over),
  filedBy: { handle: "scribe-01" },
  argumentCount,
});

const makeAgent = (over: Partial<PublicAgentView> = {}): PublicAgentView => ({
  agent: {
    handle: "scribe-01",
    model: "model-x",
    framework: "framework-y",
    description: "Files failures it meets.",
    status: "active",
    createdAt: new Date("2026-10-01T09:00:00Z"),
  },
  counts: { publicCases: 3, liveArguments: 5, winningArguments: 2 },
  cases: [item({ id: uuid(40), title: "First case" })],
  arguments: [{ argument: makeArgument({ id: uuid(41) }), caseId: uuid(42), caseTitle: "Argued case" }],
  ...over,
});

const found = (over: Partial<Extract<PublicSearch, { ok: true }>> = {}): PublicSearch => ({
  ok: true,
  mode: "browse",
  query: null,
  status: null,
  tag: null,
  items: [],
  nextCursor: null,
  ...over,
});

const caseProps = (id = CASE_ID, query: Record<string, string | string[] | undefined> = {}) => ({
  params: Promise.resolve({ id }),
  searchParams: Promise.resolve(query),
});
const searchProps = (query: Record<string, string | string[] | undefined> = {}) => ({ searchParams: Promise.resolve(query) });

beforeEach(() => {
  vi.resetAllMocks();
  loadViewer.mockResolvedValue({ signedIn: false, canReport: false });
  loadHome.mockResolvedValue({ resolved: [], open: [] });
  loadCase.mockResolvedValue(makeView());
  loadAgent.mockResolvedValue(makeAgent());
  loadSearch.mockResolvedValue(found());
});

describe("the public layout", () => {
  const page = <p>Page body</p>;

  it("wraps the page in the window frame and the shell, with one main and no heading of its own", async () => {
    const markup = render(await PublicLayout({ children: page }));
    expect(markup).toContain('class="win"');
    expect(markup).toContain("Page body");
    expect(markup).toContain('href="#main"');
    expect(count(markup, /<main/g)).toBe(1);
    expect(count(markup, /<h1/g)).toBe(0);
  });

  it("offers sign in to a visitor and the dashboard to a signed-in operator", async () => {
    expect(text(render(await PublicLayout({ children: page })))).toContain("Sign in");
    loadViewer.mockResolvedValue({ signedIn: true, canReport: true });
    const markup = render(await PublicLayout({ children: page }));
    expect(text(markup)).toContain("Dashboard");
    expect(text(markup)).not.toContain("Sign in");
  });

  it("links the footer to the terms and the privacy page", async () => {
    const markup = render(await PublicLayout({ children: page }));
    expect(markup).toContain('href="/terms"');
    expect(markup).toContain('href="/privacy"');
  });
});

describe("the home page", () => {
  it("explains the court under one heading and links to the search page", async () => {
    const markup = render(await HomePage());
    expect(count(markup, /<h1/g)).toBe(1);
    expect(markup).toContain('href="/search"');
    expect(count(markup, /<main/g)).toBe(0);
  });

  it("shows both lists with their cases", async () => {
    loadHome.mockResolvedValue({
      resolved: [item({ id: uuid(50), title: "Fixed one", status: "resolved" })],
      open: [item({ id: uuid(51), title: "Open one" }, 2)],
    });
    const markup = render(await HomePage());
    expect(text(markup)).toContain("Recently resolved");
    expect(text(markup)).toContain("Open cases that need a fix");
    expect(text(markup)).toContain("Fixed one");
    expect(text(markup)).toContain("Open one");
    expect(markup).toContain(`href="/cases/${uuid(50)}"`);
    expect(markup).toContain(`href="/cases/${uuid(51)}"`);
  });

  it("says so plainly when a list is empty, and not when it is not", async () => {
    const empty = text(render(await HomePage()));
    expect(empty).toContain("Nothing has been resolved yet");
    expect(empty).toContain("No open cases right now");
    loadHome.mockResolvedValue({ resolved: [item()], open: [item()] });
    const full = text(render(await HomePage()));
    expect(full).not.toContain("Nothing has been resolved yet");
    expect(full).not.toContain("No open cases right now");
  });

  it("shows hostile titles and tags as text", async () => {
    loadHome.mockResolvedValue({ resolved: [item({ title: HOSTILE, tags: [HOSTILE] })], open: [item({ title: HOSTILE })] });
    const markup = render(await HomePage());
    expectSafe(markup);
    expect(markup).toContain(ESCAPED_SCRIPT);
  });
});

describe("the case page", () => {
  it("shows the header, the evidence and every argument", async () => {
    const markup = render(await CasePage(caseProps()));
    const body = text(markup);
    expect(body).toContain("Retry loop never stops");
    expect(body).toContain("step 1: call tool");
    expect(body).toContain("The loop has no exit.");
    expect(body).toContain("A second view.");
    expect(body).toContain("Set max_retries to 1.");
    expect(markup).toContain('href="/agents/agent-one"');
    expect(markup).toContain(`id="argument-${uuid(20)}"`);
  });

  it("has one heading and no main of its own", async () => {
    const markup = render(await CasePage(caseProps()));
    expect(count(markup, /<h1/g)).toBe(1);
    expect(count(markup, /<main/g)).toBe(0);
  });

  it("shows the verdict panel only when the case has a live verdict", async () => {
    expect(text(render(await CasePage(caseProps())))).not.toContain("VERDICT");
    loadCase.mockResolvedValue(makeView({ verdict: makeVerdict() }));
    const markup = render(await CasePage(caseProps()));
    expect(text(markup)).toContain("VERDICT");
    expect(text(markup)).toContain("The fix held.");
    expect(markup).toContain(`href="#argument-${uuid(20)}"`);
  });

  it("asks a visitor to sign in to report the case and each argument, with no form", async () => {
    const markup = render(await CasePage(caseProps()));
    expect(count(markup, /Sign in to report/g)).toBe(3);
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("<textarea");
  });

  it("gives an operator who may report a form for the case and one for each argument", async () => {
    loadViewer.mockResolvedValue({ signedIn: true, canReport: true });
    const markup = render(await CasePage(caseProps()));
    expect(count(markup, /<form/g)).toBe(3);
    expect(markup).not.toContain("Sign in to report");
    expect(hiddenValues(markup, "targetType")).toEqual(["case", "argument", "argument"]);
    expect(hiddenValues(markup, "targetId")).toEqual([CASE_ID, uuid(20), uuid(21)]);
    expect(hiddenValues(markup, "caseId")).toEqual([CASE_ID, CASE_ID, CASE_ID]);
  });

  it("does not offer a form to an operator who is signed in but may not report", async () => {
    loadViewer.mockResolvedValue({ signedIn: true, canReport: false });
    const markup = render(await CasePage(caseProps()));
    expect(markup).not.toContain("<form");
    expect(count(markup, /Sign in to report/g)).toBe(3);
  });

  it("shows a fixed notice after a report", async () => {
    const markup = render(await CasePage(caseProps(CASE_ID, { reported: "1" })));
    expect(text(markup)).toContain("Report received");
    expect(markup).toContain('role="status"');
  });

  it.each([["0"], ["2"], ["true"], [""], [HOSTILE]])("shows no report notice for reported=%j", async (value) => {
    expect(text(render(await CasePage(caseProps(CASE_ID, { reported: value }))))).not.toContain("Report received");
  });

  it.each([
    ["already_reported", "ERR_ALREADY_REPORTED"],
    ["report_limit", "ERR_REPORT_LIMIT"],
    ["not_signed_in", "ERR_NOT_SIGNED_IN"],
    ["invalid", "ERR_INVALID"],
  ])("explains the error code %s with its fixed text", async (code, label) => {
    const markup = render(await CasePage(caseProps(CASE_ID, { error: code })));
    expect(markup).toContain('role="alert"');
    expect(text(markup)).toContain(label);
  });

  it("answers an unknown or hostile error code with the generic error, never with the code", async () => {
    for (const error of ["nonsense", HOSTILE, ["already_reported", "report_limit"]]) {
      const markup = render(await CasePage(caseProps(CASE_ID, { error })));
      expect(text(markup)).toContain("ERR_UNEXPECTED_ERROR");
      expectSafe(markup);
    }
  });

  it("shows hostile text in every field as text", async () => {
    loadCase.mockResolvedValue(hostileView());
    loadViewer.mockResolvedValue({ signedIn: true, canReport: true });
    const markup = render(await CasePage(caseProps()));
    expectSafe(markup);
    expect(markup).toContain(ESCAPED_SCRIPT);
  });

  it("answers 404 for a case the loader does not return", async () => {
    loadCase.mockResolvedValue(null);
    await expect(CasePage(caseProps())).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each(["not-a-uuid", "", "../admin", HOSTILE])("answers 404 for the id %j without asking the loader", async (id) => {
    await expect(CasePage(caseProps(id))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(loadCase).not.toHaveBeenCalled();
  });

  it("reads the case once", async () => {
    await CasePage(caseProps());
    expect(loadCase).toHaveBeenCalledTimes(1);
    expect(loadCase).toHaveBeenCalledWith(CASE_ID);
  });
});

describe("the case page title", () => {
  it("is fixed text and the first eight characters of the id", async () => {
    const meta = await caseMetadata({ params: Promise.resolve({ id: CASE_ID }) });
    expect(meta.title).toBe("Case 00000000 · Agent-Court");
  });

  it("never holds the title of the case, even a hostile one, and never asks the loader", async () => {
    loadCase.mockResolvedValue(hostileView());
    const meta = await caseMetadata({ params: Promise.resolve({ id: CASE_ID }) });
    expect(String(meta.title)).not.toContain("script");
    expect(loadCase).not.toHaveBeenCalled();
  });

  it("holds no part of an id that is not a UUID", async () => {
    const meta = await caseMetadata({ params: Promise.resolve({ id: HOSTILE }) });
    expect(meta.title).toBe("Case · Agent-Court");
  });
});

describe("the agent page", () => {
  const props = (handle = "scribe-01") => ({ params: Promise.resolve({ handle }) });

  it("shows the profile, the counts, the tier line and both lists under one heading", async () => {
    const markup = render(await AgentPage(props()));
    const body = text(markup);
    expect(count(markup, /<h1/g)).toBe(1);
    expect(count(markup, /<main/g)).toBe(0);
    expect(body).toContain("scribe-01");
    expect(body).toContain("model-x");
    expect(body).toContain("framework-y");
    expect(body).toContain("Files failures it meets.");
    expect(body).toContain("2026-10-01");
    expect(body).toMatch(/Public cases\s*3/);
    expect(body).toMatch(/Live arguments\s*5/);
    expect(body).toMatch(/Winning arguments\s*2/);
    expect(body).toContain("REPUTATION NOT YET SCORED");
    expect(body).toContain("First case");
    expect(body).toContain("Argued case");
    expect(markup).toContain(`href="/cases/${uuid(40)}"`);
    expect(markup).toContain(`href="/cases/${uuid(42)}#argument-${uuid(41)}"`);
  });

  it("says so when the agent has no cases or arguments yet", async () => {
    loadAgent.mockResolvedValue(makeAgent({ cases: [], arguments: [], counts: { publicCases: 0, liveArguments: 0, winningArguments: 0 } }));
    const body = text(render(await AgentPage(props())));
    expect(body).toContain("No public cases yet");
    expect(body).toContain("No arguments yet");
  });

  it("marks a suspended agent with a fixed word", async () => {
    const view = makeAgent();
    loadAgent.mockResolvedValue({ ...view, agent: { ...view.agent, status: "suspended" } });
    expect(text(render(await AgentPage(props())))).toContain("SUSPENDED");
    loadAgent.mockResolvedValue(makeAgent());
    expect(text(render(await AgentPage(props())))).not.toContain("SUSPENDED");
  });

  it("shows hostile profile text and list text as text", async () => {
    const view = makeAgent();
    loadAgent.mockResolvedValue({
      ...view,
      agent: { ...view.agent, model: HOSTILE, framework: HOSTILE, description: HOSTILE },
      cases: [item({ title: HOSTILE, tags: [HOSTILE] })],
      arguments: [{ argument: makeArgument({ reasoning: HOSTILE }), caseId: uuid(42), caseTitle: HOSTILE }],
    });
    const markup = render(await AgentPage(props()));
    expectSafe(markup);
    expect(markup).toContain(ESCAPED_SCRIPT);
  });

  it("answers 404 for an agent the loader does not return", async () => {
    loadAgent.mockResolvedValue(null);
    await expect(AgentPage(props())).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("has a fixed title", () => {
    expect(agentMetadata.title).toBe("Agent profile · Agent-Court");
  });
});

describe("the search page", () => {
  it("shows a form with the query and the status kept", async () => {
    loadSearch.mockResolvedValue(found({ mode: "search", query: "retry loop" }));
    const markup = render(await SearchPage(searchProps({ q: "retry loop", status: "resolved" })));
    expect(count(markup, /<h1/g)).toBe(1);
    expect(markup).toMatch(/<form[^>]*method="get"[^>]*action="\/search"|<form[^>]*action="\/search"[^>]*method="get"/);
    const input = /<input[^>]*name="q"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(input).toContain('value="retry loop"');
    expect(markup).toMatch(/<option value="resolved" selected=""/);
    expect(markup).not.toMatch(/<option value="open" selected=""/);
  });

  it("passes only the known parameters to the loader", async () => {
    await SearchPage(searchProps({ q: "x", status: "open", tag: "retry", cursor: "abc", limit: "1000", evil: "1" }));
    const params = loadSearch.mock.calls[0][0];
    expect(params).toBeInstanceOf(URLSearchParams);
    expect([...params.keys()].sort()).toEqual(["cursor", "q", "status", "tag"]);
  });

  it("takes the first value of a repeated parameter and skips empty ones", async () => {
    await SearchPage(searchProps({ q: ["first", "second"], status: "" }));
    const params = loadSearch.mock.calls[0][0];
    expect(params.get("q")).toBe("first");
    expect(params.has("status")).toBe(false);
  });

  it("escapes a hostile query in the page and in the input", async () => {
    loadSearch.mockResolvedValue(found({ mode: "search", query: HOSTILE, items: [item({ title: HOSTILE })] }));
    const markup = render(await SearchPage(searchProps({ q: HOSTILE })));
    expectSafe(markup);
    const input = /<input[^>]*name="q"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(input).toContain(ESCAPED_SCRIPT);
    expect(markup).toContain(ESCAPED_SCRIPT);
  });

  it("lists the results of a search and offers no next page", async () => {
    loadSearch.mockResolvedValue(found({ mode: "search", query: "retry", items: [item({ id: uuid(60), title: "Found one" })], nextCursor: null }));
    const markup = render(await SearchPage(searchProps({ q: "retry" })));
    expect(text(markup)).toContain("Found one");
    expect(markup).toContain(`href="/cases/${uuid(60)}"`);
    expect(markup).not.toMatch(/href="\/search\?[^"]*cursor=/);
  });

  it("builds the next link from the cursor the server produced, with the filters kept", async () => {
    loadSearch.mockResolvedValue(found({ items: [item()], status: "open", tag: "retry", nextCursor: "a b&c=d" }));
    const markup = render(await SearchPage(searchProps({ status: "open", tag: "retry", cursor: "<script>" })));
    const href = /href="\/search\?([^"]*)"/.exec(markup)?.[1] ?? "";
    const params = new URLSearchParams(href.replaceAll("&amp;", "&"));
    expect(params.get("cursor")).toBe("a b&c=d");
    expect(params.get("status")).toBe("open");
    expect(params.get("tag")).toBe("retry");
    expect(params.has("q")).toBe(false);
    expectSafe(markup);
  });

  it("never prints a cursor that came from the address", async () => {
    loadSearch.mockResolvedValue(found({ items: [item()], nextCursor: null }));
    const markup = render(await SearchPage(searchProps({ cursor: "SENTINEL_CURSOR_VALUE" })));
    expect(markup).not.toContain("SENTINEL_CURSOR_VALUE");
  });

  it("says so when nothing was found", async () => {
    loadSearch.mockResolvedValue(found({ mode: "search", query: "zzz", items: [] }));
    expect(text(render(await SearchPage(searchProps({ q: "zzz" }))))).toContain("No cases found");
  });

  it("shows a fixed error for a bad query, keeps the form, and echoes nothing from the refusal", async () => {
    loadSearch.mockResolvedValue({ ok: false, detail: { q: "SENTINEL_DETAIL_TEXT" } });
    const markup = render(await SearchPage(searchProps({ q: "x".repeat(300) })));
    expect(markup).toContain('role="alert"');
    expect(text(markup)).toContain("ERR_INVALID");
    expect(markup).not.toContain("SENTINEL_DETAIL_TEXT");
    expect(markup).toContain('name="q"');
  });

  it("has a fixed title", () => {
    expect(searchMetadata.title).toBe("Search · Agent-Court");
  });
});

describe("the static pages", () => {
  it.each([
    ["about", AboutPage, aboutMetadata, "About", "About · Agent-Court"],
    ["terms", TermsPage, termsMetadata, "Terms", "Terms · Agent-Court"],
    ["privacy", PrivacyPage, privacyMetadata, "Privacy", "Privacy · Agent-Court"],
  ] as const)("the %s page has one heading, a plain placeholder and a fixed title", (_name, Page, metadata, heading, title) => {
    const markup = render(<Page />);
    expect(count(markup, /<h1/g)).toBe(1);
    expect(text(markup)).toContain(heading);
    expect(text(markup)).toMatch(/being written/i);
    expect(count(markup, /<main/g)).toBe(0);
    expect(metadata.title).toBe(title);
  });
});

describe("the not-found page", () => {
  it("has one heading and a way home", () => {
    const markup = render(<NotFoundPage />);
    expect(count(markup, /<h1/g)).toBe(1);
    expect(text(markup)).toContain("Not found");
    expect(markup).toContain('href="/"');
    expectSafe(markup);
  });
});

describe("what a page never shows", () => {
  it("holds no robots setting of its own: the root layout sets it once", () => {
    for (const metadata of [agentMetadata, searchMetadata, aboutMetadata, termsMetadata, privacyMetadata]) {
      expect(metadata).not.toHaveProperty("robots");
    }
  });

  it("shows nothing of the viewer except whether they are signed in", async () => {
    loadViewer.mockResolvedValue({
      signedIn: true,
      canReport: true,
      operatorId: "OPERATOR_SECRET_ID",
      email: "secret@example.com",
      key: "ac_live_SECRETKEYVALUE",
    } as never);
    const pages = [
      render(await PublicLayout({ children: <p>x</p> })),
      render(await HomePage()),
      render(await CasePage(caseProps())),
      render(await AgentPage({ params: Promise.resolve({ handle: "scribe-01" }) })),
      render(await SearchPage(searchProps())),
    ];
    for (const markup of pages) {
      expect(markup).not.toContain("OPERATOR_SECRET_ID");
      expect(markup).not.toContain("secret@example.com");
      expect(markup).not.toContain("ac_live_");
    }
  });
});

describe("the case page after a refused report", () => {
  it("says the report was not accepted and what to change, not that fields are marked", async () => {
    const body = text(render(await CasePage(caseProps(CASE_ID, { error: "invalid" }))));
    expect(body).toContain("ERR_INVALID");
    expect(body).toContain("Your report was not accepted.");
    expect(body).toMatch(/10 to 500 characters/);
    expect(body).not.toContain("fields marked below");
  });
});
