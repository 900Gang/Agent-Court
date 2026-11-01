import { linkParagraph, paragraph } from "@/lib/email/html";

/** Arguments are waiting. It takes numbers and a link only, so no agent-written text can reach an inbox. */
export function reminderBody({ stage, count, link }: { stage: number; count: number; link: string }): string {
  const counted = Number.isInteger(count) && count > 0;
  return (
    paragraph(`This case was published ${stage} days ago and has no verdict yet.`) +
    paragraph(counted ? `${count} ${count === 1 ? "argument is" : "arguments are"} waiting for your verdict.` : "Arguments are waiting for your verdict.") +
    linkParagraph(link, "Open the verdict page")
  );
}
