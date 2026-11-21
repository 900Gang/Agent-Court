import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// N11 Task 1 (AC-1107): /admin/invites. Admin only, plain text, fixed messages.

vi.mock("@/lib/admin/inviteData", () => ({ loadInvitesPage: vi.fn() }));
vi.mock("@/lib/auth/requireAdmin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/app/admin/actions", () => ({ addInviteFormAction: vi.fn(), removeInviteFormAction: vi.fn() }));

import InvitesPage from "@/app/admin/invites/page";
import * as inviteData from "@/lib/admin/inviteData";
import * as requireAdminModule from "@/lib/auth/requireAdmin";

const loadInvitesPage = vi.mocked(inviteData.loadInvitesPage);
const requireAdmin = vi.mocked(requireAdminModule.requireAdmin);
const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(1)"> "q" & ‮evil';

const withoutReactScript = (markup: string) => markup.replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/, "");
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const hiddenValues = (markup: string, name: string) =>
  [...markup.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*>`, "g"))].map((match) => /value="([^"]*)"/.exec(match[0])?.[1]);

const at = new Date("2026-11-21T09:30:00.000Z");
const data = (over: Partial<Awaited<ReturnType<typeof inviteData.loadInvitesPage>>> = {}) => ({
  inviteOnly: true,
  invites: [
    { githubId: "583231", githubLogin: "octocat", invitedBy: "Ada", createdAt: at, state: "active" as const },
    { githubId: "999", githubLogin: HOSTILE, invitedBy: HOSTILE, createdAt: at, state: "not_signed_in" as const },
  ],
  ...over,
});

async function render(search: Record<string, string> = {}) {
  return withoutReactScript(renderToStaticMarkup(await InvitesPage({ searchParams: Promise.resolve(search) })));
}

beforeEach(() => {
  requireAdmin.mockReset();
  requireAdmin.mockResolvedValue({ id: "a", role: "admin", status: "active" } as never);
  loadInvitesPage.mockReset();
  loadInvitesPage.mockResolvedValue(data() as never);
});

describe("the invites page", () => {
  it("checks for an admin itself, before it reads anything", async () => {
    requireAdmin.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(loadInvitesPage).not.toHaveBeenCalled();
  });

  it("says whether the deployment is invite-only", async () => {
    expect(text(await render())).toContain("This deployment is invite-only");
    loadInvitesPage.mockResolvedValue(data({ inviteOnly: false }) as never);
    expect(text(await render())).toContain("not invite-only");
  });

  it("has one form to invite, with a login field", async () => {
    const markup = await render();
    expect(markup).toMatch(/name="login"/);
    expect(text(markup)).toContain("INVITE A GITHUB ACCOUNT");
  });

  it("lists each invite with login, id, who invited, when and the state in words", async () => {
    const content = text(await render());
    expect(content).toContain("octocat");
    expect(content).toContain("583231");
    expect(content).toContain("Ada");
    expect(content).toContain("2026-11-21 09:30 UTC");
    expect(content).toContain("ACTIVE");
    expect(content).toContain("NOT SIGNED IN YET");
    expect(content).toContain("INVITED (2)");
  });

  it("has a remove form for every invite that sends its id", async () => {
    expect(hiddenValues(await render(), "githubId")).toEqual(["583231", "999"]);
  });

  it("says nobody has been invited when the list is empty, and shows no table", async () => {
    loadInvitesPage.mockResolvedValue(data({ invites: [] }) as never);
    const markup = await render();
    expect(text(markup)).toContain("Nobody has been invited yet");
    expect(markup).not.toMatch(/<table/);
  });

  it("shows hostile text as plain characters", async () => {
    const markup = await render();
    expect(markup).not.toMatch(/<script/i);
    expect(markup).not.toMatch(/<img/i);
    expect(markup.replace(/="[^"]*"/g, '=""')).not.toMatch(/<[^>]*\sonerror\s*=/i);
    expect(text(markup)).toContain("alert(1)");
  });

  it("confirms an invite from the id in the address, using the stored login, never the address's own text", async () => {
    expect(text(await render({ added: "583231" }))).toContain("Invited octocat (GitHub id 583231)");
    expect(text(await render({ exists: "583231" }))).toContain("octocat (GitHub id 583231) was already invited");
    expect(text(await render({ added: "123456" }))).not.toContain("Invited");
    expect(await render({ added: HOSTILE })).not.toMatch(/<script/i);
  });

  it("confirms a removal", async () => {
    expect(text(await render({ removed: "1" }))).toContain("Invite removed");
    expect(text(await render({ removed: "x" }))).not.toContain("Invite removed");
  });

  it("shows a fixed message for a known error code and ignores an unknown one", async () => {
    loadInvitesPage.mockResolvedValue(data({ invites: [] }) as never);
    expect(text(await render({ error: "github_not_found" }))).toContain("GitHub does not know that login");
    expect(text(await render({ error: "invalid_login" }))).toContain("not a GitHub login");
    const unknown = await render({ error: HOSTILE });
    expect(unknown).not.toMatch(/<script/i);
    expect(text(unknown)).not.toContain("alert(1)");
  });
});
