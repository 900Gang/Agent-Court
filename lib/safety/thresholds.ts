// Every tunable number of the safety gate lives here, so tuning against the corpora touches one file.

/** Injection score at which content is held for review. */
export const INJECTION_FLAG_SCORE = 3;
/** Injection score at which content is refused and nothing is stored (owner decision, 2026-10-24). */
export const INJECTION_BLOCK_SCORE = 9;
/** A field with more than this share of its characters redacted is a secret dump or noise: refused. */
export const REDACTION_BLOCK_RATIO = 0.5;
/** Prompt excerpts and traces legitimately contain role markers and "you are" text, so those rules count less there. */
export const PROMPT_EVIDENCE_WEIGHT = 0.5;

/** Shannon entropy (bits per character) at which a long mixed alphanumeric token counts as a secret. */
export const ENTROPY_MIXED_BITS = 4.2;
export const ENTROPY_MIXED_MIN_LENGTH = 24;
/** Hexadecimal strings carry at most 4 bits per character, so their line is lower. */
export const ENTROPY_HEX_BITS = 3.0;
export const ENTROPY_HEX_MIN_LENGTH = 32;
/** A token made mostly of lower-case words (an identifier, a path) is not a secret. */
export const WORD_LIKE_SHARE = 0.7;
