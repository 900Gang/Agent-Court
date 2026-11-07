import { IMPORT } from "@/lib/config/constants";
import type { ManifestEntry } from "./manifest";

/** The entry fields that hold the builder's own words, in the order they are reported. */
export const GUARDED_FIELDS = ["title", "summary", "expected", "actual", "fixReasoning", "fixChange", "note"] as const;
export type GuardedField = (typeof GUARDED_FIELDS)[number];

// Lower case, apostrophes dropped, everything else that is not a letter or digit is a separator.
function wordsOf(text: string): string[] {
  if (typeof text !== "string") throw new TypeError("text expected");
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/['’ʼ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/** The length, in words, of the longest run of consecutive words the two texts share. Case and punctuation do not count. */
export function longestSharedRun(a: string, b: string): number {
  const first = wordsOf(a);
  const second = wordsOf(b);
  if (first.length === 0 || second.length === 0) return 0;
  const ids = new Map<string, number>();
  const idOf = (word: string): number => {
    let id = ids.get(word);
    if (id === undefined) {
      id = ids.size;
      ids.set(word, id);
    }
    return id;
  };
  const xs = first.map(idOf);
  const ys = second.map(idOf);
  let previous = new Uint32Array(ys.length + 1);
  let current = new Uint32Array(ys.length + 1);
  let best = 0;
  for (let i = 1; i <= xs.length; i++) {
    for (let j = 1; j <= ys.length; j++) {
      if (xs[i - 1] === ys[j - 1]) {
        const length = previous[j - 1] + 1;
        current[j] = length;
        if (length > best) best = length;
      } else {
        current[j] = 0;
      }
    }
    [previous, current] = [current, previous];
  }
  return best;
}

/**
 * Which fields share a run of IMPORT.paraphraseRun words or more with the source text. Field names only, never text.
 * A source that is not text throws: a missing source must never read as a pass.
 */
export function guardParaphrase(
  entry: Pick<ManifestEntry, GuardedField>,
  sourceText: string,
  run: number = IMPORT.paraphraseRun,
): { ok: true } | { ok: false; fields: GuardedField[] } {
  if (typeof sourceText !== "string") throw new TypeError("source text expected");
  const fields = GUARDED_FIELDS.filter((field) => longestSharedRun(entry[field], sourceText) >= run);
  return fields.length === 0 ? { ok: true } : { ok: false, fields };
}