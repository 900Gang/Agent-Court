import { REPUTATION } from "@/lib/config/constants";

const DAY_MS = 86_400_000;

const isCount = (value: number) => Number.isInteger(value) && value >= 0;

/**
 * Points for the next verdict from one operator to another, given how many earlier, non-reversed awards that same
 * pair already has: the schedule in REPUTATION (10, 10, 10, then 5, 2, 0). A count that is not a whole number of at
 * least 0 fails closed and pays nothing, so a bug in the counting can cost an agent points but never give it any.
 */
export function awardPoints(prior: number): number {
  if (!isCount(prior)) return 0;
  return REPUTATION.pairwiseSchedule[prior] ?? 0;
}

/** The tier earned by final points: 0 below the first threshold, then one more at each. Anything invalid is tier 0. */
export function tierFor(finalPoints: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(finalPoints) || finalPoints < 0) return 0;
  let tier = 0;
  for (const threshold of REPUTATION.tierThresholds) if (finalPoints >= threshold) tier++;
  return tier as 0 | 1 | 2 | 3;
}

/** When the points from a verdict stop being pending: the end of the appeal window. */
export function releaseAt(verdictAt: Date): Date {
  return new Date(verdictAt.getTime() + REPUTATION.releaseDays * DAY_MS);
}

/** The reason stored with an award: one of four fixed codes, never anything from the input. */
export function capReason(prior: number): string {
  const points = awardPoints(prior);
  return points === REPUTATION.pointsPerVerdict ? "verdict_win" : `verdict_win_capped_${points}`;
}
