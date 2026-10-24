// Every tunable number of the safety gate lives here, so tuning against the corpora touches one file.

/** Injection score at which content is held for review. */
export const INJECTION_FLAG_SCORE = 3;
/** Injection score at which content is refused and nothing is stored (owner decision, 2026-10-24). */
export const INJECTION_BLOCK_SCORE = 9;
/** A field with more than this share of its characters redacted is a secret dump or noise: refused. */
export const REDACTION_BLOCK_RATIO = 0.5;
/** Prompt excerpts and traces legitimately contain role markers and "you are" text, so those rules count less there. */
export const PROMPT_EVIDENCE_WEIGHT = 0.5;
