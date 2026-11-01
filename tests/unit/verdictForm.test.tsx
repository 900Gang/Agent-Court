import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CaseRow } from "@/components/dashboard/CaseRow";
import { VerdictForm } from "@/components/dashboard/VerdictForm";
import type { OperatorCaseRow } from "@/lib/services/operatorCaseService";

const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(1)">[x](javascript:alert(1)) "q" & \u202Eevil';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = new Date("2026-10-28T12:00:00.000Z");
const DAY = 86_400_000;

// React adds its own form-replay script after a form whose action is a function. It holds nothing of ours.
const withoutReactScript = (markup: string) => markup.replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/, "");
const html = (ui: React.ReactElement) => withoutReactScript(renderToStaticMarkup(ui));
const text = (markup: string) => markup.replace(/<[^>]+>/g, "");

function expectSafe(markup: string) {
  expect(markup).not.toMatch(/<script/i);
  expect(markup).not.toMatch(/<img/i);
  expect(markup.replace(/="[^"]*"/g, '=""')).not.toMatch(/<[^>]*\sonerror\s*=/i);
}

const argumentsOf = (over: Array<Partial<{ id: string; authorHandle: string; reasoning: string; proposedChange: string }>> = [{}, { id: uuid(2) }]) =>
  over.map((entry, i) => ({
    id: uuid(i + 1),
    authorHandle: `agent-${i + 1}`,
    reasoning: `Reasoning ${i + 1}`,
    proposedChange: `Change ${i + 1}`,
    createdAt: new Date("2026-10-20T10:00:00Z"),
    ...entry,
  }));

const action = vi.fn();

describe("VerdictForm", () => {
  const render = (args = argumentsOf()) => html(<VerdictForm caseId={uuid(99)} arguments={args} action={action} />);

  it("has one required radio per argument, all in one group, valued with the argument id", () => {
    const markup = render();
    const radios = [...markup.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((match) => match[0]);
    expect(radios).toHaveLength(2);
    for (const radio of radios) {
      expect(radio).toContain('name="winningArgumentId"');
      expect(radio).toMatch(/required/);
    }
    expect(radios[0]).toContain(`value="${uuid(1)}"`);
    expect(radios[1]).toContain(`value="${uuid(2)}"`);
  });

  it("carries the case id in a hidden field and nothing else hidden", () => {
    const markup = render();
    const hidden = [...markup.matchAll(/<input[^>]*type="hidden"[^>]*>/g)].map((match) => match[0]);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toContain('name="caseId"');
    expect(hidden[0]).toContain(`value="${uuid(99)}"`);
  });

  it("has an optional note limited to 500 characters", () => {
    const textarea = /<textarea[^>]*name="note"[^>]*>/.exec(render())?.[0] ?? "";
    expect(textarea).toContain('maxLength="500"');
    expect(textarea).not.toMatch(/required/);
  });

  it("says the choice is final unless appealed within 7 days, and that a winner of your own earns no points", () => {
    const body = text(render());
    expect(body).toContain("The choice is final unless appealed within 7 days.");
    expect(body).toContain("self-resolved");
  });

  it("has a submit button", () => {
    expect(render()).toMatch(/<button[^>]*type="submit"[^>]*>ISSUE VERDICT/);
  });

  it("shows each argument's author, reasoning and proposed change as text", () => {
    const body = text(render());
    for (const needle of ["agent-1", "Reasoning 1", "Change 1", "agent-2", "Reasoning 2", "Change 2"]) expect(body).toContain(needle);
  });

  it("shows hostile text as text and makes no element from it", () => {
    const markup = render(argumentsOf([{ authorHandle: HOSTILE, reasoning: HOSTILE, proposedChange: HOSTILE, id: HOSTILE }]));
    expectSafe(markup);
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows no form when there is nothing to choose from", () => {
    const markup = render([]);
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("ISSUE VERDICT");
  });
});

describe("CaseRow", () => {
  const row = (over: Partial<OperatorCaseRow> = {}): OperatorCaseRow => ({
    id: uuid(7),
    title: "Retry loop never stops",
    status: "open",
    agentHandle: "scribe-01",
    createdAt: new Date("2026-10-20T10:00:00Z"),
    argumentCount: 2,
    oldestArgumentAt: new Date(NOW.getTime() - 3 * DAY),
    ...over,
  });
  const render = (over: Partial<OperatorCaseRow> = {}) => html(<table><tbody><CaseRow row={row(over)} now={NOW} /></tbody></table>);
  const cells = (markup: string) => [...markup.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => text(match[1]).trim());

  it("shows title, agent, state, argument count, the age of the oldest argument and the action", () => {
    expect(cells(render())).toEqual(["Retry loop never stops", "scribe-01", "OPEN", "2", "3 days", "CHOOSE WINNER"]);
  });

  it("words the age as today, 1 day or n days, and a dash when there is none", () => {
    expect(cells(render({ oldestArgumentAt: new Date(NOW.getTime() - 3600_000) }))[4]).toBe("today");
    expect(cells(render({ oldestArgumentAt: new Date(NOW.getTime() - DAY) }))[4]).toBe("1 day");
    expect(cells(render({ oldestArgumentAt: new Date(NOW.getTime() + DAY) }))[4]).toBe("today");
    expect(cells(render({ oldestArgumentAt: null, argumentCount: 0 }))[4]).toBe("—");
  });

  it("links to the verdict form only for an open or argued case that has an active argument", () => {
    expect(render({ status: "argued" })).toContain(`href="/dashboard/cases/${uuid(7)}/verdict"`);
    for (const over of [{ status: "resolved" }, { status: "held" }, { status: "withdrawn" }, { argumentCount: 0, oldestArgumentAt: null }] as Array<Partial<OperatorCaseRow>>) {
      const markup = render(over);
      expect(markup, JSON.stringify(over)).not.toContain("/verdict");
      expect(cells(markup)[5]).toBe("");
    }
  });

  it("never links an id that is not a UUID", () => {
    expect(render({ id: '"><script>alert(1)</script>' })).not.toContain("/verdict");
  });

  it("writes a state with an underscore as words", () => {
    expect(cells(render({ status: "under_appeal" }))[2]).toBe("UNDER APPEAL");
  });

  it("shows a hostile title and handle as text", () => {
    const markup = render({ title: HOSTILE, agentHandle: HOSTILE });
    expectSafe(markup);
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
