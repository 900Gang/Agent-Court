export type RecallScore = { hits: number; total: number; rate: number };

/**
 * Top-N recall: a query is a hit when its true case is among the first `topN` results (3 by default). Only queries that
 * have a true case are counted, and a query with no results counts as a miss. A rate of 0, never NaN, for nothing to score.
 */
export function scoreRecall(results: Record<string, string[]>, truth: Record<string, string>, topN = 3): RecallScore {
  const ids = Object.keys(truth);
  let hits = 0;
  for (const id of ids) if ((results[id] ?? []).slice(0, topN).includes(truth[id])) hits++;
  return { hits, total: ids.length, rate: ids.length === 0 ? 0 : hits / ids.length };
}

/** Runs every query through `search` (which answers with case ids, best first) and scores the answers. */
export async function evaluate(
  queries: Array<{ id: string; text: string; truth: string }>,
  search: (text: string) => Promise<string[]>,
  topN = 3,
): Promise<RecallScore & { misses: string[] }> {
  const results: Record<string, string[]> = {};
  const truth: Record<string, string> = {};
  for (const query of queries) {
    truth[query.id] = query.truth;
    results[query.id] = await search(query.text);
  }
  const misses = queries.filter((query) => !(results[query.id] ?? []).slice(0, topN).includes(query.truth)).map((query) => query.id);
  return { ...scoreRecall(results, truth, topN), misses };
}

/** The p-th percentile (0 to 100) by linear interpolation between the sorted values. NaN for no values. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
