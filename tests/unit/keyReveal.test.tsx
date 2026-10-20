import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IssueKeyForm } from "@/components/dashboard/IssueKeyForm";
import { KeyReveal } from "@/components/dashboard/KeyReveal";
import { RegisterAgentForm } from "@/components/dashboard/RegisterAgentForm";

const html = renderToStaticMarkup;
const text = (markup: string) => markup.replace(/<[^>]+>/g, "");
const KEY = `ac_live_${"A1".repeat(16)}`;
const noopAction = async () => ({ ok: false as const });

// React reorders attributes when rendering, so look a field up by name and check attributes inside it.
function fieldTag(markup: string, name: string): string {
  const match = new RegExp(`<(?:input|textarea|select)[^>]*name="${name}"[^>]*>`).exec(markup);
  if (!match) throw new Error(`no field named ${name}`);
  return match[0];
}

describe("KeyReveal", () => {
  const markup = html(
    <KeyReveal
      keyValue={KEY}
      fingerprint="ac_live_A1A1…"
      scopes={["read", "cases:write"]}
      expiresAt="2027-01-18T12:00:00.000Z"
      baseUrl="https://agent-court.example"
      onDone={() => {}}
    />,
  );

  it("warns that the key is shown once and only a hash is stored", () => {
    expect(markup).toMatch(/SHOWN ONCE/);
    expect(markup).toMatch(/ONLY A HASH/);
  });

  it("shows the whole key as text, with a copy button", () => {
    expect(text(markup)).toContain(KEY);
    expect(markup).toMatch(/>COPY</);
  });

  it("shows four configuration tabs, with the Claude Code tab selected", () => {
    expect(markup).toContain('role="tablist"');
    for (const label of ["CLAUDE CODE (MCP)", "CURSOR", ".ENV", "CURL"]) expect(markup).toContain(label);
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>CLAUDE CODE/);
    expect(markup).toContain('role="tabpanel"');
    expect(text(markup)).toContain("claude mcp add --transport http agent-court");
  });

  it("shows the fingerprint, scopes and expiry date", () => {
    expect(text(markup)).toContain("ac_live_A1A1…");
    expect(text(markup)).toContain("read, cases:write");
    expect(text(markup)).toContain("2027-01-18");
  });

  it("shows NEVER when the key does not expire", () => {
    const never = html(
      <KeyReveal keyValue={KEY} fingerprint="f" scopes={["read"]} expiresAt={null} baseUrl="http://localhost:3000" onDone={() => {}} />,
    );
    expect(text(never)).toMatch(/NEVER/);
  });

  it("starts with an unticked confirmation and a locked DONE button", () => {
    expect(markup).toMatch(/<input[^>]*type="checkbox"/);
    expect(markup).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(markup).toMatch(/I have copied this key/);
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>DONE/);
  });
});

describe("IssueKeyForm", () => {
  const markup = html(<IssueKeyForm agentId="11111111-1111-1111-1111-111111111111" action={noopAction} />);

  it("offers the three scopes, with only read ticked by default (least privilege)", () => {
    for (const scope of ["read", "cases:write", "arguments:write"]) {
      expect(markup).toMatch(new RegExp(`<input[^>]*name="scopes"[^>]*value="${scope}"`));
    }
    const checked = [...markup.matchAll(/<input[^>]*name="scopes"[^>]*>/g)].filter((m) => /checked/.test(m[0]));
    expect(checked).toHaveLength(1);
    expect(checked[0][0]).toContain('value="read"');
  });

  it("offers 30 days, 90 days, 1 year and never, with 90 days selected", () => {
    expect(markup).toContain('name="expiresInDays"');
    for (const value of ["30", "90", "365", "never"]) expect(markup).toContain(`value="${value}"`);
    expect(markup).toMatch(/<option[^>]*value="90"[^>]*selected/);
  });

  it("limits the label to 60 characters and has a submit button", () => {
    expect(fieldTag(markup, "label")).toContain('maxLength="60"');
    expect(markup).toMatch(/<button[^>]*type="submit"/);
  });

  it("carries the agent id as a hidden field for the action to read", () => {
    expect(markup).toMatch(/<input[^>]*type="hidden"[^>]*name="agentId"[^>]*value="11111111-1111-1111-1111-111111111111"/);
  });
});

describe("RegisterAgentForm", () => {
  const markup = html(<RegisterAgentForm action={noopAction} />);

  it("has the four fields with their length limits", () => {
    expect(fieldTag(markup, "handle")).toContain('maxLength="32"');
    expect(fieldTag(markup, "model")).toContain('maxLength="80"');
    expect(fieldTag(markup, "framework")).toContain('maxLength="80"');
    expect(fieldTag(markup, "description")).toContain('maxLength="500"');
  });

  it("requires a handle and has a submit button", () => {
    expect(fieldTag(markup, "handle")).toContain("required");
    expect(markup).toMatch(/<button[^>]*type="submit"/);
  });

  it("explains the handle rules", () => {
    expect(text(markup)).toMatch(/3 to 32/);
  });
});
