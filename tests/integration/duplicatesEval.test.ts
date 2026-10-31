import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEmbeddingInput } from "@/lib/embeddings/input";
import type { EmbeddingProvider } from "@/lib/embeddings/provider";
import { evaluate } from "@/lib/search/evaluate";
import { embedCase } from "@/lib/services/embeddingService";
import { searchCases, searchKeyword } from "@/lib/services/searchService";
import { createRecordingProvider } from "../helpers/embeddings";
import { fixtureIdOf, insertDuplicatesCorpus, loadDuplicates, uuidFor } from "../helpers/duplicates";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
const fixture = loadDuplicates();

/** The queries are rewordings that share few words with their originals, and full text needs every word, so keyword search alone is weak on them by design. */
const KEYWORD_CEILING = 0.5;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  await insertDuplicatesCorpus(t.db);
}, 120_000);

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

const inputOf = (c: (typeof fixture.cases)[number]) => buildEmbeddingInput({ title: c.title, summary: c.summary, expected: c.expected, actual: c.actual, environment: {}, tags: c.tags });

/**
 * A pretend provider that knows what every text means: each case is its own direction, and each query points mostly
 * at its true case. It lets the whole path (embedding 100 cases, the vector leg, fusion) be tested without a network.
 */
function oracle(): ReturnType<typeof createRecordingProvider> {
  const overrides: Record<string, number[]> = {};
  fixture.cases.forEach((c, index) => {
    const vector = new Array<number>(1536).fill(0);
    vector[index] = 1;
    overrides[inputOf(c)] = vector;
  });
  fixture.queries.forEach((query, j) => {
    const index = fixture.cases.findIndex((c) => c.id === query.truth);
    const vector = new Array<number>(1536).fill(0);
    vector[index] = 0.9;
    vector[300 + j] = Math.sqrt(1 - 0.81);
    overrides[query.text] = vector;
  });
  return createRecordingProvider(overrides);
}

const searchIds = async (text: string, deps: Parameters<typeof searchCases>[3]) =>
  (await searchCases(t.db, "", { query: text, limit: 10 }, deps)).map((item) => fixtureIdOf(item.case.id));

describe("the corpus in the database", () => {
  it("has 100 resolved cases with the ids the fixture names", async () => {
    const [row] = await t.sql(`select count(*)::int as n from cases where status = 'resolved'`);
    expect(row.n).toBe(100);
    expect(fixtureIdOf(uuidFor("c07"))).toBe("c07");
  });
});

describe("keyword search alone on the fixture", () => {
  it("finds few of the rewordings, which is why there is a vector leg", async () => {
    const result = await evaluate(fixture.queries, async (text) => (await searchKeyword(t.db, { query: text, limit: 10 })).map((item) => fixtureIdOf(item.case.id)));
    expect(result.total).toBe(50);
    expect(result.rate).toBeLessThan(KEYWORD_CEILING);
  });
});

describe("hybrid search on the fixture, with a provider that knows the meaning", () => {
  let provider: ReturnType<typeof createRecordingProvider>;

  beforeAll(async () => {
    provider = oracle();
    for (const c of fixture.cases) expect((await embedCase(t.db, provider, uuidFor(c.id))).status, c.id).toBe("embedded");
  }, 120_000);

  it("stored one vector per case, and sent each case's own redacted fields once", async () => {
    const [row] = await t.sql(`select count(*)::int as n from case_embeddings`);
    expect(row.n).toBe(100);
    expect(provider.received().sort()).toEqual(fixture.cases.map(inputOf).sort());
  });

  it("finds the original in the first three for nearly every query", async () => {
    const result = await evaluate(fixture.queries, (text) => searchIds(text, { provider }));
    expect(result.total).toBe(50);
    expect(result.rate).toBeGreaterThanOrEqual(0.95);
  });

  it("finds it by the vector leg alone, and the keyword leg alone makes no provider call", async () => {
    const before = provider.calls.length;
    const vectorOnly = await evaluate(fixture.queries, (text) => searchIds(text, { provider, legs: ["vector"] }));
    expect(vectorOnly.rate).toBeGreaterThanOrEqual(0.95);
    expect(provider.calls.length).toBe(before + 50);

    const keywordOnly = await evaluate(fixture.queries, (text) => searchIds(text, { provider, legs: ["keyword"] }));
    expect(keywordOnly.total).toBe(50);
    expect(provider.calls.length).toBe(before + 50);
  });

  it("gives nothing from the vector leg when there is no provider", async () => {
    const none: EmbeddingProvider | null = null;
    expect(await searchIds(fixture.queries[0].text, { provider: none, legs: ["vector"] })).toEqual([]);
  });

  it("is never worse than the keyword leg alone", async () => {
    const hybrid = await evaluate(fixture.queries, (text) => searchIds(text, { provider }));
    const keyword = await evaluate(fixture.queries, (text) => searchIds(text, { provider: null }));
    expect(hybrid.rate).toBeGreaterThanOrEqual(keyword.rate);
  });
});
