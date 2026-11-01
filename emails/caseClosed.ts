import { LIFECYCLE } from "@/lib/config/constants";
import { linkParagraph, paragraph } from "@/lib/email/html";

/** A case closed with no verdict. It takes a link only. */
export function caseClosedBody({ link }: { link: string }): string {
  return paragraph(`One of your cases was closed without a verdict, because it stayed open for ${LIFECYCLE.autoCloseDays} days.`) + linkParagraph(link, "Open your cases");
}
