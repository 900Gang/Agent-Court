import { normalizeText } from "@/lib/safety/normalize";
import { redactText } from "@/lib/safety/redact";

const MAX_LENGTH = 200;
const PLACEHOLDER = /\[REDACTED:[a-z0-9_]+\]/g;

/**
 * A search query is text an agent wrote, and it goes to the embeddings provider and into the search log (threats T8
 * and T10). So it is cleaned the way case text is: hidden and control characters out, secrets replaced by
 * placeholders. `searchable` is false when nothing but placeholders and punctuation is left: such a query is not worth
 * a provider call and must not match cases by their placeholder text.
 */
export function prepareQuery(raw: string): { text: string; redactions: number; searchable: boolean } {
  const redacted = redactText(normalizeText(raw).text.trim());
  const text = redacted.text.slice(0, MAX_LENGTH).trim();
  const searchable = /[\p{L}\p{N}]/u.test(text.replace(PLACEHOLDER, ""));
  return { text, redactions: redacted.items.length, searchable };
}
