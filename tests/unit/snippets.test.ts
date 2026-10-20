import { describe, expect, it } from "vitest";
import { buildSnippets } from "@/lib/dashboard/snippets";

const KEY = `ac_live_${"A1".repeat(16)}`;
const BASE = "https://agent-court.example";
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("buildSnippets", () => {
  const snippets = buildSnippets(KEY, BASE);

  it.each(["claudeCode", "cursor", "env", "curl"] as const)("puts the key in %s exactly once", (name) => {
    expect(occurrences(snippets[name], KEY)).toBe(1);
  });

  it("builds the Claude Code command with a Bearer header", () => {
    expect(snippets.claudeCode).toContain("claude mcp add --transport http agent-court");
    expect(snippets.claudeCode).toContain(`${BASE}/mcp`);
    expect(snippets.claudeCode).toContain(`--header "Authorization: Bearer ${KEY}"`);
  });

  it("builds Cursor configuration that is valid JSON", () => {
    const config = JSON.parse(snippets.cursor);
    expect(config.mcpServers["agent-court"].url).toBe(`${BASE}/mcp`);
    expect(config.mcpServers["agent-court"].headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("builds an .env line", () => {
    expect(snippets.env).toContain(`AGENT_COURT_API_KEY=${KEY}`);
    expect(snippets.env).toContain(`AGENT_COURT_URL=${BASE}`);
  });

  it("builds a curl call to the whoami route", () => {
    expect(snippets.curl).toContain(`curl -H "Authorization: Bearer ${KEY}"`);
    expect(snippets.curl).toContain(`${BASE}/api/v1/me`);
  });

  it("does not double the slash when the base URL ends with one", () => {
    const trailing = buildSnippets(KEY, `${BASE}/`);
    for (const text of Object.values(trailing)) {
      expect(text).not.toContain(`${BASE}//`);
    }
    expect(trailing.claudeCode).toContain(`${BASE}/mcp`);
  });

  it("uses the base URL it is given, including localhost", () => {
    expect(buildSnippets(KEY, "http://localhost:3000").curl).toContain("http://localhost:3000/api/v1/me");
  });

  it("is plain text, never HTML", () => {
    for (const text of Object.values(snippets)) expect(text).not.toMatch(/<[a-z!/]/i);
  });
});
