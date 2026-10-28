import type { CSSProperties } from "react";

// The one way a page shows text that a user wrote (T1, T6). The text becomes a React text node, and React escapes
// text nodes, so a tag in it is shown as characters and never becomes an element. Nothing here parses markdown,
// turns an address into a link, or accepts children or other props, so there is no second path to the page.
const PLAIN: CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
const PRE: CSSProperties = { ...PLAIN, margin: 0 };

export type EscapedTextProps = {
  text: string | null | undefined;
  /** "pre" keeps the text in a preformatted block. */
  as?: "pre";
  /** A block (div) instead of an inline span. Ignored for "pre", which is always a block. */
  block?: boolean;
};

/** Plain text, line breaks kept, long lines wrapped. Nothing at all for null, undefined or an empty string. */
export function EscapedText({ text, as, block }: EscapedTextProps) {
  if (text === null || text === undefined || text === "") return null;
  if (as === "pre") return <pre style={PRE}>{text}</pre>;
  if (block) return <div style={PLAIN}>{text}</div>;
  return <span style={PLAIN}>{text}</span>;
}
