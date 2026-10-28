import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Argument, Case, Evidence } from "@/db/schema";
import { AgentBadge } from "@/components/AgentBadge";
import { ArgumentList } from "@/components/ArgumentList";
import { CaseCard } from "@/components/CaseCard";
import { CaseHeader } from "@/components/CaseHeader";
import { EscapedText } from "@/components/EscapedText";
import { EvidenceList } from "@/components/EvidenceList";
import { PublicShell } from "@/components/PublicShell";
import { ReputationTier } from "@/components/ReputationTier";
import { ConfirmationBadge, StatusBadge } from "@/components/StatusBadge";
import { VerdictPanel } from "@/components/VerdictPanel";
import type { PublicCaseView, PublicVerdict } from "@/lib/services/observerService";

const html = renderToStaticMarkup;
const ID = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";
const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(1)">[x](javascript:alert(1)) "q" & \u202Eevil';

const ALLOWED_LINK = /^(?:\/|\/search|\/about|\/dashboard|\/terms|\/privacy|\/cases\/[0-9a-f-]{36}|\/agents\/[a-z0-9][a-z0-9-]{2,31}|#main|#argument-[0-9a-f-]{36})$/;

/** No markup was made from user text, and every link goes only where the site itself goes. */
function expectSafe(markup: string) {
  expect(markup).not.toMatch(/<script/i);
  expect(markup).not.toMatch(/<img/i);
  expect(markup).not.toMatch(/<iframe|<style/i);
  expect(markup).not.toMatch(/<[^>]*\sonerror\s*=/i);
  expect(markup).not.toMatch(/<[^>]*\sstyle="[^"]*url\(/i);
  for (const match of markup.matchAll(/href="([^"]*)"/g)) {
    expect(match[1], `link ${match[1]}`).toMatch(ALLOWED_LINK);
  }
}

const makeCase = (over: Partial<Case> = {}): Case =>
  ({
    id: ID,
    agentId: ID2,
    title: "A title",
    summary: "A summary",
    expected: "What was expected",
    actual: "What happened",
    environment: {},
    tags: [],
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
    id: ID,
    caseId: ID2,
    agentId: ID2,
    status: "active",
    reasoning: "The loop has no exit.",
    proposedChange: "Set max_retries to 1.",
    createdAt: new Date("2026-10-21T10:00:00Z"),
    ...over,
  }) as unknown as Argument;

const makeEvidence = (over: Partial<Evidence> = {}): Evidence =>
  ({ id: ID, caseId: ID2, kind: "trace", status: "active", redactedText: "step 1", createdAt: new Date("2026-10-20T10:00:00Z"), ...over }) as unknown as Evidence;

const makeVerdict = (over: Partial<PublicVerdict> = {}): PublicVerdict => ({
  id: ID,
  status: "active",
  decidedBy: "operator",
  verificationLevel: "operator_confirmed",
  note: "The fix held.",
  createdAt: new Date("2026-10-22T10:00:00Z"),
  winningArgumentId: ID2,
  ...over,
});

const makeView = (over: Partial<PublicCaseView> = {}): PublicCaseView => ({
  case: makeCase(),
  filedBy: { handle: "scribe-01" },
  evidence: [],
  arguments: [],
  verdict: null,
  ...over,
});

describe("StatusBadge and ConfirmationBadge", () => {
  const CASE_STATUSES = ["held", "open", "argued", "resolved", "under_appeal", "closed_unresolved", "withdrawn", "rejected"];
  const ARGUMENT_STATUSES = ["active", "won", "lost", "overturned", "held", "withdrawn", "rejected"];
  const text = (markup: string) => markup.replace(/<[^>]+>/g, "");

  it.each([...new Set([...CASE_STATUSES, ...ARGUMENT_STATUSES])])("gives %s a fixed label inside a chip", (status) => {
    const markup = html(<StatusBadge status={status as never} />);
    expect(markup).toMatch(/class="[^"]*\bchip\b/);
    expect(text(markup)).toMatch(/^[A-Z][A-Z -]+$/);
    expect(text(markup)).not.toBe("UNKNOWN");
  });

  it("gives every case status its own label", () => {
    const labels = CASE_STATUSES.map((status) => text(html(<StatusBadge status={status as never} />)));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("gives every argument status its own label", () => {
    const labels = ARGUMENT_STATUSES.map((status) => text(html(<StatusBadge status={status as never} />)));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("never shows a status it does not know, only a fixed word", () => {
    const markup = html(<StatusBadge status={HOSTILE as never} />);
    expect(text(markup)).toBe("UNKNOWN");
    expectSafe(markup);
  });

  it.each(["operator_confirmed", "self_resolved", "imported", "auto_verified"])("labels the %s confirmation level", (level) => {
    const markup = html(<ConfirmationBadge level={level as never} />);
    expect(text(markup)).toMatch(/^[A-Z][A-Z -]+$/);
    expect(text(markup)).not.toBe("UNKNOWN");
  });

  it("gives every confirmation level its own label, and never shows an unknown one", () => {
    const levels = ["operator_confirmed", "self_resolved", "imported", "auto_verified"];
    const labels = levels.map((level) => text(html(<ConfirmationBadge level={level as never} />)));
    expect(new Set(labels).size).toBe(levels.length);
    expect(text(html(<ConfirmationBadge level={HOSTILE as never} />))).toBe("UNKNOWN");
  });
});

describe("CaseCard", () => {
  const item = (over: Partial<Case> = {}, handle = "scribe-01", argumentCount = 2) => ({
    case: makeCase(over),
    filedBy: { handle },
    argumentCount,
  });

  it("shows the title as a link to the case, the status, the filer, the count and the date", () => {
    const markup = html(<CaseCard item={item({ title: "Retry loop", tags: ["retry", "tool-call"], status: "resolved" })} />);
    expect(markup).toContain(`href="/cases/${ID}"`);
    expect(markup).toContain("Retry loop");
    expect(markup).toContain("RESOLVED");
    expect(markup).toContain('href="/agents/scribe-01"');
    expect(markup).toMatch(/2 arguments/);
    expect(markup).toContain("2026-10-20");
    expect(markup).toContain("retry");
    expect(markup).toContain("tool-call");
    expectSafe(markup);
  });

  it("says '1 argument' and '0 arguments' correctly", () => {
    expect(html(<CaseCard item={item({}, "scribe-01", 1)} />)).toMatch(/1 argument(?!s)/);
    expect(html(<CaseCard item={item({}, "scribe-01", 0)} />)).toMatch(/0 arguments/);
  });

  it("shows hostile text in every field as text, and links nothing it cannot trust", () => {
    const markup = html(<CaseCard item={item({ id: HOSTILE, title: HOSTILE, summary: HOSTILE, tags: [HOSTILE] }, HOSTILE)} />);
    expectSafe(markup);
    expect(markup).not.toContain("/cases/&lt;");
    expect(markup).not.toContain("/agents/&lt;");
    expect(markup).toContain("&lt;script&gt;");
  });
});

describe("CaseHeader", () => {
  it("shows one heading, the status, the filer, the dates and the three text fields with labels", () => {
    const markup = html(<CaseHeader view={makeView({ case: makeCase({ title: "Retry loop", tags: ["retry"] }) })} />);
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(markup).toContain("Retry loop");
    expect(markup).toContain("OPEN");
    expect(markup).toContain('href="/agents/scribe-01"');
    expect(markup).toContain("2026-10-20");
    for (const label of ["SUMMARY", "EXPECTED", "ACTUAL"]) expect(markup).toContain(label);
    expect(markup).toContain("A summary");
    expect(markup).toContain("What was expected");
    expect(markup).toContain("What happened");
    expect(markup).toContain("retry");
    expectSafe(markup);
  });

  it("shows the environment facts it knows, and nothing it does not", () => {
    const environment = { model: "model-a", framework: "framework-b", framework_version: "1.2.3", language: "typescript", os: "Windows 11", tools: ["search", "calculator"], notes: "Ran on a laptop.", secret_field: "NOT-SHOWN" };
    const markup = html(<CaseHeader view={makeView({ case: makeCase({ environment }) })} />);
    for (const shown of ["model-a", "framework-b", "1.2.3", "typescript", "Windows 11", "search", "calculator", "Ran on a laptop."]) {
      expect(markup).toContain(shown);
    }
    expect(markup).not.toContain("NOT-SHOWN");
    expect(markup).not.toContain("secret_field");
  });

  it("ignores environment values that are not text, so no object is printed", () => {
    const environment = { model: { a: 1 }, os: 42, tools: "not-a-list", notes: ["x"] };
    const markup = html(<CaseHeader view={makeView({ case: makeCase({ environment }) })} />);
    expect(markup).not.toContain("[object Object]");
    expect(markup).not.toContain("not-a-list");
  });

  it("shows the confirmation badge only when there is a verdict", () => {
    expect(html(<CaseHeader view={makeView()} />)).not.toMatch(/CONFIRMED|SELF-RESOLVED|IMPORTED|AUTO-VERIFIED/);
    const withVerdict = html(<CaseHeader view={makeView({ verdict: makeVerdict({ verificationLevel: "self_resolved" }) })} />);
    expect(withVerdict).toContain("SELF-RESOLVED");
  });

  it("shows hostile text in every field as text", () => {
    const hostileCase = makeCase({
      title: HOSTILE,
      summary: HOSTILE,
      expected: HOSTILE,
      actual: HOSTILE,
      tags: [HOSTILE],
      environment: { model: HOSTILE, framework: HOSTILE, framework_version: HOSTILE, language: HOSTILE, os: HOSTILE, tools: [HOSTILE], notes: HOSTILE },
    });
    const markup = html(<CaseHeader view={makeView({ case: hostileCase, filedBy: { handle: HOSTILE } })} />);
    expectSafe(markup);
    expect(markup.match(/<h1/g)).toHaveLength(1);
  });
});

describe("EvidenceList", () => {
  it("shows each item's kind and text, in a block that keeps its line breaks", () => {
    const markup = html(
      <EvidenceList
        items={[
          makeEvidence({ id: ID, kind: "trace", redactedText: "line one\nline two" }),
          makeEvidence({ id: ID2, kind: "tool_schema", redactedText: "{}" }),
          makeEvidence({ kind: "prompt", redactedText: "You are..." }),
          makeEvidence({ kind: "error", redactedText: "boom" }),
        ]}
      />,
    );
    for (const label of ["TRACE", "TOOL SCHEMA", "PROMPT", "ERROR"]) expect(markup).toContain(label);
    expect(markup).toMatch(/<pre[^>]*white-space:pre-wrap/);
    expect(markup).toContain("line one\nline two");
    expectSafe(markup);
  });

  it("says so when there is no evidence", () => {
    expect(html(<EvidenceList items={[]} />)).toContain("No evidence attached.");
  });

  it("shows hostile evidence as text, and never prints an unknown kind", () => {
    const markup = html(<EvidenceList items={[makeEvidence({ redactedText: HOSTILE, kind: HOSTILE as never })]} />);
    expectSafe(markup);
    expect(markup).toContain("UNKNOWN");
  });
});

describe("ArgumentList", () => {
  const entry = (over: Partial<Argument> = {}, authorHandle = "fixer-02") => ({ argument: makeArgument(over), authorHandle });

  it("shows each argument with its author, status, reasoning and proposed change", () => {
    const markup = html(<ArgumentList items={[entry({ status: "won" })]} />);
    expect(markup).toContain(`id="argument-${ID}"`);
    expect(markup).toContain('href="/agents/fixer-02"');
    expect(markup).toContain("WON");
    expect(markup).toContain("REASONING");
    expect(markup).toContain("PROPOSED CHANGE");
    expect(markup).toContain("The loop has no exit.");
    expect(markup).toContain("Set max_retries to 1.");
    expect(markup).toMatch(/<pre[^>]*white-space:pre-wrap/);
    expectSafe(markup);
  });

  it("says so when there are none", () => {
    expect(html(<ArgumentList items={[]} />)).toContain("No arguments yet.");
  });

  it("puts what the page gives it, per argument, in a slot, and only when it is given", () => {
    const items = [entry({ id: ID }), entry({ id: ID2 })];
    const withSlot = html(<ArgumentList items={items} renderReport={(id) => <span>REPORT-SLOT-{id}</span>} />);
    expect(withSlot).toContain(`REPORT-SLOT-${ID}`);
    expect(withSlot).toContain(`REPORT-SLOT-${ID2}`);
    expect(html(<ArgumentList items={items} />)).not.toContain("REPORT-SLOT");
  });

  it("shows hostile text as text and links or anchors nothing it cannot trust", () => {
    const markup = html(<ArgumentList items={[entry({ id: HOSTILE, reasoning: HOSTILE, proposedChange: HOSTILE, status: HOSTILE as never }, HOSTILE)]} />);
    expectSafe(markup);
    expect(markup).not.toContain('id="argument-&lt;');
    expect(markup).toContain("UNKNOWN");
  });
});

describe("VerdictPanel", () => {
  it("renders nothing without a verdict", () => {
    expect(html(<VerdictPanel verdict={null} />)).toBe("");
  });

  it("shows the level, who decided, the note and a link to the winning argument", () => {
    const markup = html(<VerdictPanel verdict={makeVerdict({ decidedBy: "auto", verificationLevel: "auto_verified" })} />);
    expect(markup).toContain("AUTO-VERIFIED");
    expect(markup).toMatch(/AUTO/);
    expect(markup).toContain("The fix held.");
    expect(markup).toContain(`href="#argument-${ID2}"`);
    expectSafe(markup);
  });

  it("marks a verdict that is under appeal", () => {
    expect(html(<VerdictPanel verdict={makeVerdict({ status: "under_appeal" })} />)).toContain("UNDER APPEAL");
  });

  it("shows no note line when there is none", () => {
    const markup = html(<VerdictPanel verdict={makeVerdict({ note: null })} />);
    expect(markup).not.toContain("NOTE");
  });

  it("shows a hostile note as text and links only a well-formed argument id", () => {
    const markup = html(<VerdictPanel verdict={makeVerdict({ note: HOSTILE, winningArgumentId: HOSTILE })} />);
    expectSafe(markup);
    expect(markup).not.toContain('href="#argument-&lt;');
  });
});

describe("AgentBadge and ReputationTier", () => {
  it("links a valid handle to its profile and shows the model as text", () => {
    const markup = html(<AgentBadge handle="scribe-01" model="model-a" />);
    expect(markup).toContain('href="/agents/scribe-01"');
    expect(markup).toContain("scribe-01");
    expect(markup).toContain("model-a");
    expectSafe(markup);
  });

  it("omits the model when there is none", () => {
    expect(html(<AgentBadge handle="scribe-01" model={null} />)).not.toContain("null");
  });

  it("shows a hostile handle and model as text, without a link", () => {
    const markup = html(<AgentBadge handle={HOSTILE} model={HOSTILE} />);
    expectSafe(markup);
    expect(markup).not.toContain("<a ");
  });

  it("says reputation is not yet scored", () => {
    expect(html(<ReputationTier />)).toContain("REPUTATION NOT YET SCORED");
  });
});

describe("PublicShell", () => {
  const shell = (signedIn: boolean, child = <p>child</p>) => html(<PublicShell signedIn={signedIn}>{child}</PublicShell>);

  it("has a skip link, the brand, the three links, a menu for narrow screens and the footer links, each once", () => {
    const markup = shell(false);
    expect(markup).toContain('href="#main"');
    expect(markup).toContain("Skip to content");
    for (const href of ["/", "/search", "/about", "/terms", "/privacy"]) {
      expect(markup.split(`href="${href}"`).length - 1, href).toBe(1);
    }
    expect(markup).toContain("<details");
    expect(markup).toContain("<summary");
    expect(markup).toContain("AGENT-COURT");
    expectSafe(markup);
  });

  it("offers Sign in to a visitor and Dashboard to a signed-in operator, both to the dashboard", () => {
    const visitor = shell(false);
    expect(visitor).toContain("Sign in");
    expect(visitor).not.toContain("Dashboard");
    const operator = shell(true);
    expect(operator).toContain("Dashboard");
    expect(operator).not.toContain("Sign in");
    for (const markup of [visitor, operator]) expect(markup.split('href="/dashboard"').length - 1).toBe(1);
  });

  it("has exactly one main region, which holds the page", () => {
    const markup = shell(false, <p>THE-PAGE</p>);
    expect(markup.match(/<main[^>]*id="main"/g)).toHaveLength(1);
    expect(markup.match(/<main/g)).toHaveLength(1);
    expect(markup.slice(markup.indexOf("<main"), markup.indexOf("</main>"))).toContain("THE-PAGE");
  });

  it("is the same around any page, hostile or not", () => {
    const chrome = (markup: string) => markup.slice(0, markup.indexOf("<main")) + markup.slice(markup.indexOf("</main>"));
    const plain = shell(false, <p>x</p>);
    const hostile = shell(false, <EscapedText text={HOSTILE} block />);
    expect(chrome(hostile)).toBe(chrome(plain));
    expectSafe(hostile);
  });
});

describe("the public components are plain server components", () => {
  const files = [
    "AgentBadge",
    "ArgumentList",
    "CaseCard",
    "CaseHeader",
    "EvidenceList",
    "PublicShell",
    "ReputationTier",
    "StatusBadge",
    "VerdictPanel",
  ].map((name) => path.join("components", `${name}.tsx`));

  it.each(files)("%s runs only on the server, takes data and touches no service or database", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/["']use client["']/);
    expect(source).not.toMatch(/^import (?!type)[^;]*from ["']@\/(?:lib\/services|db)/m);
    expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });

  it("all exist", () => {
    const present = readdirSync("components");
    for (const file of files) expect(present).toContain(path.basename(file));
  });
});
