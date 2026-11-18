import { ALERTS } from "@/lib/config/constants";
import { linkParagraph, paragraph } from "@/lib/email/html";
import type { AlertFinding } from "@/lib/alerts/rules";

// An alert email holds a rule name, numbers, the names of scheduled routes (fixed by our code) and one link to the metrics
// page. Never a case, an argument, an agent's text, an address, or anything else that someone wrote.

const FOOTER = "You are receiving this because this address is the alert address of this Agent-Court deployment.";

const percent = (part: number, whole: number) => `${((part / whole) * 100).toFixed(0)}%`;

function line(finding: AlertFinding): string {
  switch (finding.rule) {
    case "flag_rate":
      return `The safety gate flagged or blocked ${finding.flagged} of ${finding.screened} screened texts (${percent(finding.flagged, finding.screened)}) in the current and the previous hour. The alert level is ${percent(ALERTS.flagMinShare, 1)} of at least ${ALERTS.flagMinScreened} texts.`;
    case "rate_limited":
      return `${finding.rateLimited} of ${finding.requests} authenticated API requests (${percent(finding.rateLimited, finding.requests)}) were answered with 429 in the current and the previous hour. The alert level is ${percent(ALERTS.rateMinShare, 1)} of at least ${ALERTS.rateMinRequests} requests.`;
    case "cron_missed":
      return `These scheduled routes have had no successful run for more than ${ALERTS.missedFactor} times their normal gap: ${finding.routes.join(", ")}.`;
  }
}

const SUBJECT: Record<AlertFinding["rule"], string> = {
  flag_rate: "Agent-Court alert: flag rate is high",
  rate_limited: "Agent-Court alert: many requests are being refused with 429",
  cron_missed: "Agent-Court alert: a scheduled route has stopped",
};

/** One message for one fired rule. `baseUrl` is the site's own address, for the one link. */
export function alertMessage(finding: AlertFinding, baseUrl: string, to: string): { to: string; subject: string; html: string; text: string } {
  const link = `${baseUrl.replace(/\/+$/, "")}/admin/metrics`;
  const body = line(finding);
  return {
    to,
    subject: SUBJECT[finding.rule],
    html: `<!doctype html><html lang="en"><body>${paragraph(body)}${linkParagraph(link, "Open the metrics page")}${paragraph(FOOTER)}</body></html>`,
    text: `${body}\n\nOpen the metrics page: ${link}\n\n${FOOTER}\n`,
  };
}

