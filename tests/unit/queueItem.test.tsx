import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QueueItem } from "@/components/admin/QueueItem";

const ID = "00000000-0000-4000-8000-0000000000aa";
const noop = async () => {};
const base = {
  kind: "case" as const,
  id: ID,
  agentHandle: "scribe-01",
  createdAt: new Date("2026-10-25T10:30:00Z"),
  heading: "Plain title",
  fields: [{ label: "SUMMARY", text: "Plain summary" }],
  gate: null,
  action: noop,
};

const html = (over: Partial<Parameters<typeof QueueItem>[0]> = {}) => renderToStaticMarkup(<QueueItem {...base} {...over} />);

function hiddenValues(markup: string, name: string): string[] {
  return [...markup.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*>`, "g"))].map((match) => /value="([^"]*)"/.exec(match[0])?.[1] ?? "");
}

describe("QueueItem: what it shows", () => {
  it("shows the kind, the agent, the time and the stored text", () => {
    const markup = html();
    expect(markup).toContain("CASE");
    expect(markup).toContain("scribe-01");
    expect(markup).toContain("2026-10-25 10:30");
    expect(markup).toContain("Plain title");
    expect(markup).toContain("SUMMARY");
    expect(markup).toContain("Plain summary");
  });

  it.each([
    ["case", "CASE"],
    ["evidence", "EVIDENCE"],
    ["argument", "ARGUMENT"],
  ] as const)("labels a %s item %s", (kind, label) => {
    expect(html({ kind })).toContain(label);
  });

  it("shows the gate summary as rule ids and redaction types with counts", () => {
    const markup = html({
      gate: {
        version: "2026-10-25.2",
        outcome: "flag",
        rules: [{ rule: "ignore_previous", count: 3 }],
        redactions: [{ type: "email", count: 2 }],
      },
    });
    expect(markup).toContain("2026-10-25.2");
    expect(markup).toContain("flag");
    expect(markup).toContain("ignore_previous (3)");
    expect(markup).toContain("email (2)");
  });

  it("says plainly when there is no gate report", () => {
    expect(html({ gate: null })).toContain("NO GATE REPORT");
  });
});

describe("QueueItem: stored text is shown as plain text (T11)", () => {
  const hostile = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "[x](javascript:alert(1))",
    `${"A".repeat(5000)}`,
  ];
  // React 19 adds one inline script of its own (the form-replay listener) next to a form with a function action.
  // Drop exactly that one, so any other script in the markup fails the test.
  const REACT_FORM_SCRIPT = /<script>addEventListener\("submit"[\s\S]*?<\/script>/;
  const markup = html({
    heading: 'He said "hi" & <b>left</b>',
    fields: hostile.map((text, index) => ({ label: `FIELD ${index}`, text })),
  }).replace(REACT_FORM_SCRIPT, "");

  it("escapes markup, so it appears as text and never as elements", () => {
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<img");
    expect(markup).not.toMatch(/<[^>]*\sonerror=/);
    expect(markup).not.toContain("<b>left");
  });

  it("escapes quotes and ampersands in a heading", () => {
    expect(markup).toContain("He said &quot;hi&quot; &amp; &lt;b&gt;left&lt;/b&gt;");
  });

  it("renders a link-looking string as text, with no anchor", () => {
    expect(markup).toContain("[x](javascript:alert(1))");
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain('href="javascript');
  });

  it("keeps a very long line whole, in a block that keeps line breaks and wraps", () => {
    expect(markup).toContain("A".repeat(5000));
    expect(markup).toMatch(/<pre[^>]*style="[^"]*white-space:pre-wrap/);
    expect(markup).toMatch(/<pre[^>]*style="[^"]*overflow-wrap:anywhere/);
  });

  it("never uses dangerouslySetInnerHTML", () => {
    expect(readFileSync("components/admin/QueueItem.tsx", "utf8")).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("QueueItem: the two forms", () => {
  const markup = html();

  it("has an approve form and a reject form, each carrying the kind, the id and the decision", () => {
    expect(markup.match(/<form/g)).toHaveLength(2);
    expect(hiddenValues(markup, "decision").sort()).toEqual(["approve", "reject"]);
    expect(hiddenValues(markup, "kind")).toEqual(["case", "case"]);
    expect(hiddenValues(markup, "id")).toEqual([ID, ID]);
    expect(markup).toContain("APPROVE");
    expect(markup).toContain("REJECT");
  });

  it("makes both buttons submit buttons", () => {
    expect(markup.match(/<button[^>]*type="submit"/g)).toHaveLength(2);
  });
});
