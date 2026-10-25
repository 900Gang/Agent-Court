/**
 * Counts of the links in a text, never the links themselves. This module only reads strings: it never makes a
 * network request and never rewrites the text, so a tracking pixel or a hostile URL in a case is inert until a
 * person or an agent chooses to open it.
 */
export type LinkScan = {
  /** Web links (http and https). */
  total: number;
  /** Occurrences of schemes that run code or reach local resources, by scheme. */
  dangerous: Record<string, number>;
  /** Markdown images with a remote address, and HTML tags that load or run something. */
  beacons: number;
};

// A scheme only counts when it is not the tail of a longer word ("notjavascript:").
const DANGEROUS: ReadonlyArray<readonly [string, RegExp]> = [
  ["javascript", /(?<![A-Za-z0-9])javascript:/gi],
  ["vbscript", /(?<![A-Za-z0-9])vbscript:/gi],
  ["data_html", /(?<![A-Za-z0-9])data:text\/html/gi],
  ["data_application", /(?<![A-Za-z0-9])data:application\//gi],
  ["file", /(?<![A-Za-z0-9])file:\/\//gi],
  ["ftp", /(?<![A-Za-z0-9])ftp:\/\//gi],
];

const WEB_LINK = /\bhttps?:\/\//gi;
const MARKDOWN_IMAGE = /!\[[^\]]{0,200}\]\(\s*https?:\/\//gi;
// Opening tags only: a closing tag is not a second beacon.
const HTML_BEACON = /<(?:img|iframe|script|link|object)\b/gi;

function count(text: string, regex: RegExp): number {
  return Array.from(text.matchAll(regex)).length;
}

export function scanLinks(text: string): LinkScan {
  const dangerous: Record<string, number> = {};
  for (const [scheme, regex] of DANGEROUS) {
    const found = count(text, regex);
    if (found > 0) dangerous[scheme] = found;
  }
  return {
    total: count(text, WEB_LINK),
    dangerous,
    beacons: count(text, MARKDOWN_IMAGE) + count(text, HTML_BEACON),
  };
}

/** 3 per dangerous link (at most 9) plus 2 per beacon (at most 6). Ordinary links score 0. */
export function linkScore(scan: LinkScan): number {
  const dangerous = Object.values(scan.dangerous).reduce((sum, n) => sum + n, 0);
  return Math.min(dangerous * 3, 9) + Math.min(scan.beacons * 2, 6);
}
