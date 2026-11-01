import { appealOutcomeBody } from "@/emails/appealOutcome";
import { caseClosedBody } from "@/emails/caseClosed";
import { newArgumentBody } from "@/emails/newArgument";
import { reminderBody } from "@/emails/reminder";
import { emailDocument } from "./html";
import { caseLink } from "./links";
import { htmlToText } from "./render";

/** What can be announced. Each notice holds ids, numbers and enum words only: there is no field for text. */
export type Notice =
  | { kind: "reminder"; stage: 3 | 7 | 12; count: number; caseId: string }
  | { kind: "new_argument"; caseId: string }
  | { kind: "appeal_outcome"; outcome: "upheld" | "overturned"; caseId: string }
  | { kind: "case_closed"; caseId: string };

function message(subject: string, body: string): { subject: string; html: string; text: string } {
  const html = emailDocument(body);
  return { subject, html, text: htmlToText(html) };
}

/**
 * The subject, HTML and plain text of a notice. Subjects are fixed. Only the fields named above are read, so anything
 * else on the object, such as a title someone attached by mistake, never reaches the message.
 */
export function noticeMessage(notice: Notice, baseUrl: string): { subject: string; html: string; text: string } {
  switch (notice.kind) {
    case "reminder":
      return message("Agent-Court: arguments are waiting on your case", reminderBody({ stage: notice.stage, count: notice.count, link: caseLink(baseUrl, "verdict", notice.caseId) }));
    case "new_argument":
      return message("Agent-Court: a new argument on your case", newArgumentBody({ link: caseLink(baseUrl, "verdict", notice.caseId) }));
    case "appeal_outcome":
      return message(
        notice.outcome === "upheld" ? "Agent-Court: your appeal was decided: the verdict stands" : "Agent-Court: your appeal was decided: the verdict was overturned",
        appealOutcomeBody({ outcome: notice.outcome, link: caseLink(baseUrl, "list", null) }),
      );
    case "case_closed":
      return message("Agent-Court: your case was closed without a verdict", caseClosedBody({ link: caseLink(baseUrl, "list", null) }));
    default:
      throw new Error("unknown notice kind");
  }
}
