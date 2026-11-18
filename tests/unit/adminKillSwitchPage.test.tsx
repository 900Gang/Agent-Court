import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// N10 Task 1 (AC-1007): /admin/kill-switch. The page reads its view from lib/admin/killSwitchData.ts and posts to two
// form actions in app/admin/actions.ts. Everything it shows is a plain text node.

vi.mock("@/lib/admin/killSwitchData", () => ({ loadKillSwitchView: vi.fn() }));
vi.mock("@/lib/auth/requireAdmin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/app/admin/actions", () => ({ killSwitchFormAction: vi.fn(), agentStatusFormAction: vi.fn() }));

import KillSwitchPage from "@/app/admin/kill-switch/page";
import * as killSwitchData from "@/lib/admin/killSwitchData";
import * as requireAdminModule from "@/lib/auth/requireAdmin";

const loadKillSwitchView = vi.mocked(killSwitchData.loadKillSwitchView);
const requireAdmin = vi.mocked(requireAdminModule.requireAdmin);

const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(1)">[x](javascript:alert(1)) "q" & ‮evil';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = { id: uuid(900), displayName: "Admin Ada", email: "ada@example.com", role: "admin", status: "active" } as never;

const withoutReactScript = (markup: string) => markup.replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/, "");
const text = (markup: string) => markup.replace(/<[^>]+>/g, "");
const hiddenValues = (markup: string, name: string) =>
  [...markup.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*>`, "g"))].map((match) => /value="([^"]*)"/.exec(match[0])?.[1]);

async function render(search: { error?: string } = {}) {
  const ui = await KillSwitchPage({ searchParams: Promise.resolve(search) });
  return withoutReactScript(renderToStaticMarkup(ui));
}

const view = (over: Partial<Awaited<ReturnType<typeof killSwitchData.loadKillSwitchView>>> = {}) => ({
  on: false,
  envOn: false,
  agents: [
    { agentId: uuid(1), handle: "retry-bot", operatorName: "Ada", status: "active" as const },
    { agentId: uuid(2), handle: "loop-bot", operatorName: HOSTILE, status: "suspended" as const },
  ],
  truncated: false,
  ...over,
});

beforeEach(() => {
  requireAdmin.mockReset();
  requireAdmin.mockResolvedValue(ADMIN);
  loadKillSwitchView.mockReset();
  loadKillSwitchView.mockResolvedValue(view());
});

describe("the kill switch page", () => {
  it("checks for an admin itself, before it reads anything", async () => {
    requireAdmin.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(loadKillSwitchView).not.toHaveBeenCalled();
  });

  it("says the switch is off, and offers to turn it on", async () => {
    const markup = await render();
    expect(text(markup)).toMatch(/KILL SWITCH/);
    expect(text(markup)).toMatch(/OFF/);
    expect(hiddenValues(markup, "value")).toContain("on");
    expect(markup).toMatch(/name="reason"/);
  });

  it("says the switch is on, and offers to turn it off", async () => {
    loadKillSwitchView.mockResolvedValue(view({ on: true }));
    const markup = await render();
    expect(text(markup)).toMatch(/\bON\b/);
    expect(hiddenValues(markup, "value")).toContain("off");
  });

  it("says when the environment holds the switch on, which a form cannot change", async () => {
    loadKillSwitchView.mockResolvedValue(view({ on: false, envOn: true }));
    const markup = await render();
    expect(text(markup)).toMatch(/environment/i);
    expect(text(markup)).toMatch(/\bON\b/);
  });

  it("lists each agent with its handle and status, and a form that sends the other status", async () => {
    const markup = await render();
    expect(text(markup)).toContain("retry-bot");
    expect(text(markup)).toContain("loop-bot");
    expect(hiddenValues(markup, "agentId")).toEqual([uuid(1), uuid(2)]);
    expect(hiddenValues(markup, "status")).toEqual(["suspended", "active"]);
  });

  it("shows hostile text as plain characters", async () => {
    const markup = await render();
    expect(markup).not.toMatch(/<script/i);
    expect(markup).not.toMatch(/<img/i);
    expect(markup.replace(/="[^"]*"/g, '=""')).not.toMatch(/<[^>]*\sonerror\s*=/i);
    expect(text(markup)).toContain("alert(1)");
  });

  it("says when the list was cut short", async () => {
    loadKillSwitchView.mockResolvedValue(view({ truncated: true }));
    expect(text(await render())).toMatch(/first|newest|more/i);
  });

  it("shows a fixed message for a known error code and ignores an unknown one", async () => {
    loadKillSwitchView.mockResolvedValue(view({ agents: [] })); // so only the error block can show the address text
    const known = await render({ error: "invalid_reason" });
    expect(text(known)).toContain("10 to 200 characters");
    const unknown = await render({ error: HOSTILE });
    expect(unknown).not.toMatch(/<script/i);
    expect(text(unknown)).not.toContain("alert(1)");
  });
});
