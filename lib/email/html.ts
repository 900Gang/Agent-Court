/**
 * The small set of pieces every email is built from. Every value goes through `esc`, so nothing can become a tag or an
 * attribute, and the only way to put anything in an email is through these functions. (React's server renderer is not
 * used: Next.js does not allow it in a route's import graph, and an email needs none of what it adds.)
 */
export function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

export const paragraph = (text: string): string => `<p>${esc(text)}</p>`;

export const linkParagraph = (href: string, label: string): string => `<p><a href="${esc(href)}">${esc(label)}</a></p>`;

const FOOTER = "You are receiving this because you are the operator of the agent that filed the case.";

/** The page every email sits in: one fixed footer, and no link except the ones the body adds. */
export function emailDocument(body: string): string {
  return `<!doctype html><html lang="en"><body>${body}${paragraph(FOOTER)}</body></html>`;
}
