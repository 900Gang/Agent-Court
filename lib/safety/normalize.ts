export type Stripped = { zeroWidth: number; bidi: number; tag: number; control: number };

// Characters removed because they are invisible or change how text is displayed. Zero-width characters and
// tag characters hide instructions and split secrets; bidi controls reorder what a reader sees.
const HIDDEN =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]|[\u{e0000}-\u{e007f}]/gu;

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad]);

/**
 * Folds text to a form the rest of the gate can match reliably: NFKC (fullwidth letters, ligatures), line
 * endings to LF, and invisible or reordering characters removed and counted. Newlines and tabs stay.
 * Emoji variation selectors stay; zero-width joiners go, so emoji sequences split (accepted).
 */
export function normalizeText(input: string): { text: string; stripped: Stripped } {
  const stripped: Stripped = { zeroWidth: 0, bidi: 0, tag: 0, control: 0 };
  const folded = input.normalize("NFKC").replace(/\r\n?/g, "\n");
  const cleaned = folded.replace(HIDDEN, (char) => {
    const code = char.codePointAt(0) as number;
    if (code >= 0xe0000) stripped.tag++;
    else if (ZERO_WIDTH.has(code)) stripped.zeroWidth++;
    else if (code === 0x061c || (code >= 0x200e && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      stripped.bidi++;
    } else stripped.control++;
    return "";
  });
  // Removing a character can leave marks next to a base letter that now compose.
  return { text: cleaned.normalize("NFKC"), stripped };
}
