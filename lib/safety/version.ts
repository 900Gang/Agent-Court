/**
 * The version of the gate's rules: patterns, scoring rules, thresholds and normalization. Change it whenever any
 * of them changes. Moderation rows store it, so a re-scan can find content that older rules screened.
 * Format: the date of the change, then a counter for that day.
 */
export const GATE_VERSION = "2026-10-25.1";
