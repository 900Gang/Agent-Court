import { PATTERNS } from "./patterns";
import {
  ENTROPY_HEX_BITS,
  ENTROPY_HEX_MIN_LENGTH,
  ENTROPY_MIXED_BITS,
  ENTROPY_MIXED_MIN_LENGTH,
  WORD_LIKE_SHARE,
} from "./thresholds";

/** Where a secret was and what kind it was. Never the text itself. Positions are in the input text. */
export type RedactionItem = { type: string; start: number; length: number };

type Span = { type: string; start: number; end: number; rank: number };

// On an identical span a fixed-format pattern beats a context rule, which beats entropy.
const CONTEXT_RANK = 1000;
const ENTROPY_RANK = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIT_SHA = /^[0-9a-f]{40}$/;

function patternSpans(text: string, out: Span[]): void {
  PATTERNS.forEach((rule, rank) => {
    for (const match of text.matchAll(rule.regex)) {
      let start = match.index as number;
      let end = start + match[0].length;
      if (rule.group !== undefined) {
        const span = (match as RegExpMatchArray & { indices?: Array<[number, number] | undefined> }).indices?.[rule.group];
        if (!span) continue;
        [start, end] = span;
      }
      if (rule.validate && !rule.validate(text.slice(start, end))) continue;
      if (end > start) out.push({ type: rule.type, start, end, rank });
    }
  });
}

// ---- values after secret-like names (password=..., "api_key": "...", Authorization: Basic ...)

// A name counts only when the keyword is the end of the identifier, so DB_PASSWORD and GITHUB_TOKEN match,
// while max_tokens, tokenizer and api_key_header do not.
const KEYWORD =
  /(?:secret|access|private|account|signing|encryption|auth)[_-]?key|api[_-]?key|passphrase|password|passwd|pwd|secret|token|authorization|auth|credentials?/gi;
const WORD_CHAR = /[A-Za-z0-9_-]/;
const TERMINATORS = new Set([" ", "\t", "\r", "\n", '"', "'", "\\", ",", ";", "&", ")", "}", "]", "`"]);
const PLACEHOLDER_START = /^[<$*{[%(`]/;
const PLACEHOLDER_WORD =
  /^(?:x{3,}|\*+|\.{3,}|null|none|nil|undefined|true|false|redacted|changeme|change[-_]me|placeholder|example|dummy|sample|todo|tbd)$/i;
const PLACEHOLDER_PREFIX = /^(?:your|my)[-_]/i;
const AUTH_SCHEME = /^(?:basic|digest|token|bearer)[ \t]+/i;
const MAX_VALUE = 256;
const MIN_VALUE = 6;

/** Length of one quote character at `pos`, written plainly or escaped (backslash then quote); 0 when there is none. */
function quoteLength(text: string, pos: number): number {
  const c = text[pos];
  if (c === '"' || c === "'") return 1;
  if (c === "\\" && (text[pos + 1] === '"' || text[pos + 1] === "'")) return 2;
  return 0;
}

function blanks(text: string, pos: number): number {
  let i = pos;
  while ((text[i] === " " || text[i] === "\t") && i - pos < 8) i++;
  return i;
}

function looksLikeSecret(value: string, separator: string, quoted: boolean): boolean {
  if (value.length < MIN_VALUE) return false;
  if (PLACEHOLDER_START.test(value) || PLACEHOLDER_WORD.test(value) || PLACEHOLDER_PREFIX.test(value)) return false;
  // "invalid token: expected" is prose; a secret after a bare colon has a digit or a symbol.
  if (separator === ":" && !quoted && !/[^A-Za-z]/.test(value)) return false;
  return true;
}

function contextSpans(text: string, out: Span[]): void {
  for (const hit of text.matchAll(KEYWORD)) {
    const keywordEnd = (hit.index as number) + hit[0].length;
    if (keywordEnd < text.length && WORD_CHAR.test(text[keywordEnd])) continue;

    let pos = keywordEnd + quoteLength(text, keywordEnd);
    pos = blanks(text, pos);
    const separator = text[pos];
    if (separator !== "=" && separator !== ":") continue;
    pos++;
    if (text[pos] === separator) continue; // == and ::, not an assignment
    pos = blanks(text, pos);

    const open = quoteLength(text, pos);
    const quoted = open > 0;
    pos += open;

    if (/^authorization$/i.test(hit[0])) {
      const scheme = AUTH_SCHEME.exec(text.slice(pos, pos + 16));
      if (scheme) pos += scheme[0].length;
    }

    let end = pos;
    while (end < text.length && end - pos < MAX_VALUE && !TERMINATORS.has(text[end])) end++;
    if (end > pos && looksLikeSecret(text.slice(pos, end), separator, quoted)) {
      out.push({ type: "generic_secret", start: pos, end, rank: CONTEXT_RANK });
    }
  }
}

// ---- long random-looking tokens

const MIXED_TOKEN = /[A-Za-z0-9+/_-]{24,}={0,2}/g;
const HEX_RUN = /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g;
const DIGEST_PREFIX = /^sha(?:256|384|512)-/i;
const DIGEST_LABEL = /sha(?:1|256|384|512)[:-]$/i;

function shannon(token: string): number {
  const counts = new Map<string, number>();
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / token.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Share of the token inside runs of three or more lower-case letters: identifiers and paths are made of words. */
function wordShare(token: string): number {
  let inWords = 0;
  for (const run of token.match(/[a-z]{3,}/g) ?? []) inWords += run.length;
  return inWords / token.length;
}

const precededByDigestLabel = (text: string, start: number) =>
  DIGEST_LABEL.test(text.slice(Math.max(0, start - 8), start));

function entropySpans(text: string, out: Span[]): void {
  for (const match of text.matchAll(MIXED_TOKEN)) {
    const token = match[0];
    const start = match.index as number;
    if (token.length < ENTROPY_MIXED_MIN_LENGTH || !/[A-Za-z]/.test(token) || !/[0-9]/.test(token)) continue;
    if (DIGEST_PREFIX.test(token) || precededByDigestLabel(text, start) || UUID.test(token)) continue;
    if (wordShare(token) >= WORD_LIKE_SHARE) continue;
    if (shannon(token) < ENTROPY_MIXED_BITS) continue;
    out.push({ type: "high_entropy", start, end: start + token.length, rank: ENTROPY_RANK });
  }
  for (const match of text.matchAll(HEX_RUN)) {
    const token = match[0];
    const start = match.index as number;
    if (token.length < ENTROPY_HEX_MIN_LENGTH || GIT_SHA.test(token) || precededByDigestLabel(text, start)) continue;
    if (shannon(token) < ENTROPY_HEX_BITS) continue;
    out.push({ type: "high_entropy", start, end: start + token.length, rank: ENTROPY_RANK + 1 });
  }
}

/**
 * Replaces secrets with `[REDACTED:<type>]` and reports where they were. Expects normalized text.
 * Order of authority on one stretch of text: an earlier start, then a longer span, then fixed-format patterns
 * over context rules over entropy. Idempotent: placeholders are never redacted again.
 */
export function redactText(text: string): { text: string; items: RedactionItem[] } {
  if (text.trim() === "") return { text, items: [] };
  const spans: Span[] = [];
  patternSpans(text, spans);
  contextSpans(text, spans);
  entropySpans(text, spans);
  spans.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.rank - b.rank);

  const items: RedactionItem[] = [];
  let output = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    output += text.slice(cursor, span.start) + `[REDACTED:${span.type}]`;
    items.push({ type: span.type, start: span.start, length: span.end - span.start });
    cursor = span.end;
  }
  return { text: output + text.slice(cursor), items };
}

/** The share of characters that were redacted (0 for empty text). */
export function redactedRatio(text: string, items: RedactionItem[]): number {
  if (text.length === 0) return 0;
  let covered = 0;
  for (const item of items) covered += item.length;
  return covered / text.length;
}
