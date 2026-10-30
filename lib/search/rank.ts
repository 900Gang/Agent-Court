/**
 * Reciprocal rank fusion. Each leg is a list of case ids, best first. A case scores 1 / (k + rank) in every leg that
 * holds it (rank counts from 1), and the scores add up. A case found by two legs beats one found by a single leg
 * unless that leg ranked it far higher. Ties keep the order in which a case first appeared: the first leg, then its
 * own order. A case repeated within one leg counts only at its best place.
 */
export function fuse(legs: string[][], k = 60): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  for (const leg of legs) {
    const seen = new Set<string>();
    leg.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      if (!firstSeen.has(id)) firstSeen.set(id, firstSeen.size);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (firstSeen.get(a.id) as number) - (firstSeen.get(b.id) as number));
}

/** Resolved cases first, each group keeping its order. Returns a new list. */
export function resolvedFirst<T>(items: T[], isResolved: (item: T) => boolean): T[] {
  return [...items.filter(isResolved), ...items.filter((item) => !isResolved(item))];
}
