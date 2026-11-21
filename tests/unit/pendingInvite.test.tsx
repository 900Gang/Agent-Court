import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PendingNotice } from "@/components/dashboard/PendingNotice";

// N11 Task 1 (AC-1107): the pending notice says INVITE ONLY when that is the reason, and keeps the vetting text.

const now = new Date("2026-11-21T12:00:00.000Z");
const old = new Date("2025-01-01T00:00:00.000Z");
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = (props: Partial<Parameters<typeof PendingNotice>[0]> = {}) =>
  renderToStaticMarkup(<PendingNotice githubCreatedAt={old} now={now} {...props} />);

describe("PendingNotice", () => {
  it("keeps the vetting text and says nothing about invites by default", () => {
    const content = text(render());
    expect(content).toContain("PENDING VETTING");
    expect(content).not.toContain("INVITE ONLY");
  });

  it("says nothing about invites when the deployment is not invite-only", () => {
    expect(text(render({ inviteOnly: false, invited: false }))).not.toContain("INVITE ONLY");
  });

  it("says nothing about invites to someone who is on the list", () => {
    expect(text(render({ inviteOnly: true, invited: true }))).not.toContain("INVITE ONLY");
  });

  it("says INVITE ONLY to someone who is not on the list, with what to do next", () => {
    const content = text(render({ inviteOnly: true, invited: false }));
    expect(content).toContain("INVITE ONLY");
    expect(content).toContain("not on the invite list yet");
    expect(content).toContain("the next time you sign in");
  });

  it("still shows the vetting text under the invite text, because both may apply", () => {
    const content = text(render({ inviteOnly: true, invited: false, githubCreatedAt: new Date(now.getTime() - 5 * 86_400_000) }));
    expect(content).toContain("INVITE ONLY");
    expect(content).toContain("PENDING VETTING");
    expect(content).toContain("becomes eligible in 25 days");
  });

  it("is fixed text: no value of the operator reaches it", () => {
    const markup = render({ inviteOnly: true, invited: false });
    expect(markup).not.toMatch(/<script/i);
    expect(markup).toMatch(/role="status"/);
  });
});
