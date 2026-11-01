import { linkParagraph, paragraph } from "@/lib/email/html";

/** A new argument arrived. It takes a link only. */
export function newArgumentBody({ link }: { link: string }): string {
  return paragraph("A new argument was added to one of your cases.") + paragraph("Open the verdict page to read it and choose a winner.") + linkParagraph(link, "Open the verdict page");
}
