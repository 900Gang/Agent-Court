import { MIN_GITHUB_ACCOUNT_AGE_DAYS } from "@/lib/services/operatorService";

const DAY_MS = 86_400_000;

/** Whole days until the GitHub account reaches the minimum age: 0 when old enough, null when unknown. */
export function daysUntilEligible(githubCreatedAt: Date | null, now: Date): number | null {
  if (githubCreatedAt === null) return null;
  const remaining = githubCreatedAt.getTime() + MIN_GITHUB_ACCOUNT_AGE_DAYS * DAY_MS - now.getTime();
  return Math.max(0, Math.ceil(remaining / DAY_MS));
}
