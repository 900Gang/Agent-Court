import { describe, expect, it } from "vitest";
import { esc } from "@/lib/email/html";
import { caseLink } from "@/lib/email/links";
import { noticeMessage, type Notice } from "@/lib/email/notices";
import { htmlToText } from "@/lib/email/render";

const BASE = "https://court.example";
const CASE = "00000000-0000-4000-8000-000000000007";
const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(1)">[x](javascript:alert(1)) "q" & ‮evil';

const NOTICES: Array<[string, Notice, string]> = [
  ["a reminder on day 3", { kind: "reminder", stage: 3, count: 2, caseId: CASE }, "Agent-Court: arguments are waiting on your case"],
  ["a reminder on day 7", { kind: "reminder", stage: 7, count: 1, caseId: CASE }, "Agent-Court: arguments are waiting on your case"],
  ["a reminder on day 12", { kind: "reminder", stage: 12, count: 5, caseId: CASE }, "Agent-Court: arguments are waiting on your case"],
  ["a new argument", { kind: "new_argument", caseId: CASE }, "Agent-Court: a new argument on your case"],
  ["an upheld appeal", { kind: "appeal_outcome", outcome: "upheld", caseId: CASE }, "Agent-Court: your appeal was decided: the verdict stands"],
  ["an overturned appeal", { kind: "appeal_outcome", outcome: "overturned", caseId: CASE }, "Agent-Court: your appeal was decided: the verdict was overturned"],
  ["a closed case", { kind: "case_closed", caseId: CASE }, "Agent-Court: your case was closed without a verdict"],
];

describe("caseLink", () => {
  it("builds the verdict page link for a well-formed case id", () => {
    expect(caseLink(BASE, "verdict", CASE)).toBe(`${BASE}/dashboard/cases/${CASE}/verdict`);
  });

  it("builds the list link for the list, and falls back to it for an id that is not a UUID or is missing", () => {
    expect(caseLink(BASE, "list", CASE)).toBe(`${BASE}/dashboard/cases`);
    for (const bad of [HOSTILE, "../admin", "", null, "00000000-0000-4000-8000-00000000000z"]) {
      expect(caseLink(BASE, "verdict", bad as string)).toBe(`${BASE}/dashboard/cases`);
    }
  });

  it("uses only the origin of the base address", () => {
    expect(caseLink("https://court.example/some/path?x=1#frag", "verdict", CASE)).toBe(`https://court.example/dashboard/cases/${CASE}/verdict`);
    expect(caseLink("https://court.example/", "list", null)).toBe("https://court.example/dashboard/cases");
    expect(caseLink("http://localhost:3000", "list", null)).toBe("http://localhost:3000/dashboard/cases");
  });

  it.each(["", "not a url", "javascript:alert(1)", "ftp://court.example", "//court.example"])("refuses the base address %j", (base) => {
    expect(() => caseLink(base, "list", null)).toThrow(RangeError);
  });
});

describe("esc", () => {
  it("turns every character that could start a tag or end an attribute into an entity", () => {
    expect(esc(HOSTILE)).not.toMatch(/[<>"']/);
    expect(esc(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &#x27; f");
  });
});

describe("htmlToText", () => {
  it("gives a complete HTML document and a plain text version without markup", () => {
    const { html, text } = noticeMessage({ kind: "new_argument", caseId: CASE }, BASE);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(text).not.toMatch(/<[^>]+>/);
    expect(text).not.toContain("&amp;");
  });

  it("turns a link into its words and its address in the plain text", () => {
    expect(htmlToText('<p>Read <a href="https://court.example/x">the case</a> now.</p>')).toContain("the case (https://court.example/x)");
  });

  it("decodes entities and keeps paragraphs apart", () => {
    expect(htmlToText("<div><p>Fish &amp; chips</p><p>&lt;tag&gt;</p></div>")).toBe("Fish & chips\n\n<tag>");
  });
});

describe.each(NOTICES)("the email for %s", (_name, notice, subject) => {
  const message = noticeMessage(notice, BASE);

  it("has its fixed subject", () => {
    expect(message.subject).toBe(subject);
  });

  it("links to the case in the dashboard, in both versions", () => {
    const link = notice.kind === "case_closed" || notice.kind === "appeal_outcome" ? `${BASE}/dashboard/cases` : `${BASE}/dashboard/cases/${CASE}/verdict`;
    expect(message.html).toContain(`href="${link}"`);
    expect(message.text).toContain(link);
  });

  it("holds no script, no image and no other link", () => {
    expect(message.html).not.toMatch(/<script|<img|<iframe|<style/i);
    const links = [...message.html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
    expect(links).toHaveLength(1);
    expect(links[0].startsWith(`${BASE}/dashboard/cases`)).toBe(true);
  });

  it("says why the operator is getting it", () => {
    expect(message.text).toContain("You are receiving this because you are the operator of the agent that filed the case.");
  });
});

describe("the email text", () => {
  it("counts the arguments in a reminder, in the singular and the plural", () => {
    expect(noticeMessage({ kind: "reminder", stage: 3, count: 1, caseId: CASE }, BASE).text).toContain("1 argument is waiting");
    expect(noticeMessage({ kind: "reminder", stage: 3, count: 3, caseId: CASE }, BASE).text).toContain("3 arguments are waiting");
  });

  it("says how long ago the case was published", () => {
    for (const stage of [3, 7, 12] as const) {
      expect(noticeMessage({ kind: "reminder", stage, count: 2, caseId: CASE }, BASE).text).toContain(`${stage} days ago`);
    }
  });

  it("leaves the count out rather than print something that is not a count", () => {
    for (const count of [0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { text } = noticeMessage({ kind: "reminder", stage: 7, count, caseId: CASE }, BASE);
      expect(text).not.toMatch(/NaN|Infinity|-2|1\.5/);
      expect(text).toContain("Arguments are waiting");
    }
  });

  it("says what each appeal outcome means", () => {
    expect(noticeMessage({ kind: "appeal_outcome", outcome: "upheld", caseId: CASE }, BASE).text).toContain("The verdict stands");
    expect(noticeMessage({ kind: "appeal_outcome", outcome: "overturned", caseId: CASE }, BASE).text).toContain("The verdict was overturned");
  });
});

describe("what can never get into an email", () => {
  it("ignores every property it was not designed to read, so agent-written text cannot ride along", () => {
    const smuggled = { kind: "new_argument", caseId: CASE, title: "MARK_title", summary: "MARK_summary", handle: "MARK_handle", reasoning: "MARK_reasoning", name: "MARK_name", email: "MARK_email" } as unknown as Notice;
    const message = noticeMessage(smuggled, BASE);
    for (const part of [message.subject, message.html, message.text]) expect(part).not.toContain("MARK_");
  });

  it("shows a hostile case id as nothing: it falls back to the list link", () => {
    for (const notice of [
      { kind: "new_argument", caseId: HOSTILE },
      { kind: "reminder", stage: 3, count: 1, caseId: HOSTILE },
    ] as Notice[]) {
      const message = noticeMessage(notice, BASE);
      expect(message.html).not.toContain("alert(1)");
      expect(message.text).not.toContain("alert(1)");
      expect(message.html).toContain(`href="${BASE}/dashboard/cases"`);
    }
  });

  it("refuses a notice of a kind it does not know", () => {
    expect(() => noticeMessage({ kind: "surprise", caseId: CASE } as unknown as Notice, BASE)).toThrow();
  });
});
