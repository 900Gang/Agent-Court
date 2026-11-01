import { linkParagraph, paragraph } from "@/lib/email/html";

/** An appeal was decided. It takes the outcome and a link only. */
export function appealOutcomeBody({ outcome, link }: { outcome: "upheld" | "overturned"; link: string }): string {
  return (
    paragraph("Your appeal was decided.") +
    paragraph(outcome === "upheld" ? "The verdict stands." : "The verdict was overturned, and the case can get a new verdict.") +
    linkParagraph(link, "Open your cases")
  );
}
