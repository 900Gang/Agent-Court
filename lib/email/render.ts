const ENTITIES: Array<[RegExp, string]> = [
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#x27;|&#39;/g, "'"],
  [/&amp;/g, "&"],
];

/** The plain text of some markup: links become "label (address)", paragraphs are kept apart, tags and entities are gone. */
export function htmlToText(markup: string): string {
  let text = markup
    .replace(/<head>[\s\S]*?<\/head>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_match, href: string, label: string) => `${label.replace(/<[^>]+>/g, "")} (${href})`)
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/(?:p|div|h1|h2|h3|li|tr)>/g, "\n\n")
    .replace(/<[^>]+>/g, "");
  for (const [pattern, replacement] of ENTITIES) text = text.replace(pattern, replacement);
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
