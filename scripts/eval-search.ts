import path from "node:path";
import { fileURLToPath } from "node:url";

// Usage: pnpm eval:search
//
// Measures duplicate recall on the 100-case fixture (AC-708) with the real embeddings provider. It loads the fixture into
// an in-process test database, embeds the 100 cases, and for each of the 50 rewordings checks whether the original is in
// the first three results, for the keyword leg alone, the vector leg alone and both together. It also prints how similar
// the true matches are, so the similarity bars can be set from data. It prints counts and numbers only, never any text.
// It needs OPENAI_API_KEY (in .env.local) and costs a few cents: about 200 short embedding requests.

type Env = Record<string, string | undefined>;

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

const pct = (rate: number) => `${(rate * 100).toFixed(0)}%`;
const fixed = (value: number) => (Number.isNaN(value) ? "n/a" : value.toFixed(3));

export async function runEvaluation(env: Env = process.env): Promise<void> {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set. Put it in .env.local; this script never prints it.");

  const { createOpenAiProvider } = await import("@/lib/embeddings/provider");
  const { evaluate, percentile } = await import("@/lib/search/evaluate");
  const { embedCase } = await import("@/lib/services/embeddingService");
  const { searchCases, searchKeyword } = await import("@/lib/services/searchService");
  const { createTestDb } = await import("../tests/helpers/db");
  const { fixtureIdOf, insertDuplicatesCorpus, loadDuplicates, uuidFor } = await import("../tests/helpers/duplicates");

  const provider = createOpenAiProvider(key);
  const fixture = loadDuplicates();
  const t = await createTestDb();
  try {
    await t.sql("set role app_server");
    await insertDuplicatesCorpus(t.db);

    console.log(`embedding ${fixture.cases.length} cases with ${provider.model} ...`);
    const statuses: Record<string, number> = {};
    for (const c of fixture.cases) {
      const { status } = await embedCase(t.db, provider, uuidFor(c.id), { timeoutMs: 30_000 });
      statuses[status] = (statuses[status] ?? 0) + 1;
    }
    console.log("embedding results:", JSON.stringify(statuses));
    if (statuses.embedded !== fixture.cases.length) throw new Error("not every case was embedded; stopping");

    const ids = async (promise: Promise<Array<{ case: { id: string } }>>) => (await promise).map((item) => fixtureIdOf(item.case.id));
    const keyword = await evaluate(fixture.queries, (text) => ids(searchKeyword(t.db, { query: text, limit: 10 })));
    const vector = await evaluate(fixture.queries, (text) => ids(searchCases(t.db, "", { query: text, limit: 10 }, { provider, legs: ["vector"], timeoutMs: 30_000 })));
    const hybrid = await evaluate(fixture.queries, (text) => ids(searchCases(t.db, "", { query: text, limit: 10 }, { provider, timeoutMs: 30_000 })));
    console.log("");
    console.log("top-3 recall (the original is among the first three results):");
    console.log(`  keyword only: ${keyword.hits}/${keyword.total} (${pct(keyword.rate)})`);
    console.log(`  vector only:  ${vector.hits}/${vector.total} (${pct(vector.rate)})`);
    console.log(`  hybrid:       ${hybrid.hits}/${hybrid.total} (${pct(hybrid.rate)})   bar: 80%   ${hybrid.rate >= 0.8 ? "PASS" : "FAIL"}`);
    if (hybrid.misses.length > 0) console.log(`  hybrid misses: ${hybrid.misses.join(", ")}`);

    // How similar is each query to its true case, and to the nearest wrong case? This sets the bars in SEARCH_TUNING.
    const stored = await t.sql(`select case_id, embedding::text as v from case_embeddings`);
    const vectors = new Map(stored.map((row) => [fixtureIdOf(String(row.case_id)), JSON.parse(String(row.v)) as number[]]));
    const queryVectors = await provider.embed(fixture.queries.map((query) => query.text), { timeoutMs: 30_000 });
    const trueSims: number[] = [];
    const bestWrong: number[] = [];
    fixture.queries.forEach((query, index) => {
      trueSims.push(cosine(queryVectors[index], vectors.get(query.truth) as number[]));
      let best = -1;
      for (const [id, vector] of vectors) if (id !== query.truth) best = Math.max(best, cosine(queryVectors[index], vector));
      bestWrong.push(best);
    });
    console.log("");
    console.log("cosine similarity of a query to its original:");
    console.log(`  min ${fixed(percentile(trueSims, 0))}  p10 ${fixed(percentile(trueSims, 10))}  median ${fixed(percentile(trueSims, 50))}  max ${fixed(percentile(trueSims, 100))}`);
    console.log("cosine similarity of a query to its nearest other case:");
    console.log(`  min ${fixed(percentile(bestWrong, 0))}  median ${fixed(percentile(bestWrong, 50))}  p90 ${fixed(percentile(bestWrong, 90))}  max ${fixed(percentile(bestWrong, 100))}`);
    for (const bar of [0.25, 0.3, 0.35, 0.4, 0.45, 0.5]) {
      const found = trueSims.filter((value) => value >= bar).length;
      const wrong = bestWrong.filter((value) => value >= bar).length;
      console.log(`  bar ${bar.toFixed(2)}: original at or above the bar for ${found}/${trueSims.length} queries; a wrong case at or above it for ${wrong}/${bestWrong.length}`);
    }
  } finally {
    await t.sql("reset role");
    await t.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEvaluation().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "evaluation failed");
    process.exitCode = 1;
  });
}
