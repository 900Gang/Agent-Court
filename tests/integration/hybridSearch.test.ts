import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEARCH_TUNING } from "@/lib/config/constants";
import { searchCases, searchKeyword } from "@/lib/services/searchService";
import { createRecordingProvider, slowProvider, throwingProvider, unitVector } from "../helpers/embeddings";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";
import type { EmbeddingProvider } from "@/lib/embeddings/provider";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
let nextAxis = 0;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

const MODEL = "test-embedding-model";
const aws = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const token = () => f.uniq("needle").replace(/-/g, "x");

/**
 * Each test gets its own pair of axes, so vectors from other tests are orthogonal to its query and never match.
 * `query` is the vector the provider returns for the query text; `at(c)` is a case vector whose cosine with it is c.
 */
function axes() {
  const a = nextAxis;
  nextAxis += 2;
  const at = (c: number) => {
    const vector = new Array<number>(1536).fill(0);
    vector[a] = c;
    vector[a + 1] = Math.sqrt(Math.max(0, 1 - c * c));
    return vector;
  };
  return { query: unitVector(a), at };
}

async function setVector(caseId: string, vector: number[], model = MODEL) {
  await t.sql(`insert into case_embeddings (case_id, model, dim, embedding, text_hash) values ($1, $2, 1536, $3::vector, 'h')`, [caseId, model, `[${vector.join(",")}]`]);
}

async function makeCase(over: Parameters<typeof f.insertCase>[1] = {}) {
  const filer = await f.makeAgent();
  return f.insertCase(filer.actor.agentId, { status: "open", title: "Unrelated title", summary: "Unrelated summary", ...over });
}

const viewer = async () => (await f.makeAgent()).actor.agentId;
const ids = (items: Array<{ case: { id: string } }>) => items.map((item) => item.case.id);
const run = async (query: string, provider: EmbeddingProvider | null, extra: { limit?: number; timeoutMs?: number } = {}) =>
  searchCases(t.db, await viewer(), { query, limit: extra.limit ?? 20 }, { provider, ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }) });

describe("the tuning for the vector leg", () => {
  it("has a floor that is above noise and below the bar for a similar case", () => {
    expect(SEARCH_TUNING.vectorMinSimilarity).toBeGreaterThan(0.1);
    expect(SEARCH_TUNING.vectorMinSimilarity).toBeLessThan(SEARCH_TUNING.minSimilarity);
  });
});

describe("the vector leg", () => {
  it("finds a case that shares no words with the query, and leaves out one that is far away", async () => {
    const { query, at } = axes();
    const text = `retry storm ${token()}`;
    const paraphrase = await makeCase({ title: "Agent hammers the API after being throttled" });
    const unrelated = await makeCase({ title: "Structured output drops a nested array" });
    await setVector(paraphrase.id, at(0.9));
    await setVector(unrelated.id, at(0.05));
    const found = ids(await run(text, createRecordingProvider({ [text]: query })));
    expect(found).toContain(paraphrase.id);
    expect(found).not.toContain(unrelated.id);
  });

  it("orders vector-only matches by how near they are", async () => {
    const { query, at } = axes();
    const text = `semantic only ${token()}`;
    const nearest = await makeCase();
    const middle = await makeCase();
    const farthest = await makeCase();
    await setVector(farthest.id, at(0.5));
    await setVector(nearest.id, at(0.95));
    await setVector(middle.id, at(0.7));
    const found = ids(await run(text, createRecordingProvider({ [text]: query })));
    expect(found.filter((id) => [nearest.id, middle.id, farthest.id].includes(id))).toEqual([nearest.id, middle.id, farthest.id]);
  });

  it("uses only the vectors of the provider's own model", async () => {
    const { query, at } = axes();
    const text = `model match ${token()}`;
    const c = await makeCase();
    await setVector(c.id, at(0.95), "some-older-model");
    expect(ids(await run(text, createRecordingProvider({ [text]: query })))).not.toContain(c.id);
  });
});

describe("fusing the legs", () => {
  it("puts a case found by both legs ahead of cases found by one", async () => {
    const { query, at } = axes();
    const word = token();
    const text = word;
    const both = await makeCase({ title: "Other words", actual: `Mentions ${word}` });
    const keywordOnly = await makeCase({ title: `${word} in the title` });
    const vectorOnly = await makeCase({ title: "A paraphrase with different words" });
    await setVector(both.id, at(0.99));
    await setVector(vectorOnly.id, at(0.9));
    const found = ids(await run(text, createRecordingProvider({ [text]: query })));
    expect(found.slice(0, 3)).toEqual([both.id, keywordOnly.id, vectorOnly.id]);
  });

  it("puts resolved cases first, whatever their score", async () => {
    const { query, at } = axes();
    const word = token();
    const open = await makeCase({ status: "open", title: `${word} in the title` });
    const resolved = await makeCase({ status: "resolved", title: "Other", summary: `Mentions ${word}` });
    await setVector(open.id, at(0.99));
    const found = ids(await run(word, createRecordingProvider({ [word]: query })));
    expect(found).toEqual([resolved.id, open.id]);
  });

  it("applies the limit after fusing", async () => {
    const { query, at } = axes();
    const word = token();
    const cases = [];
    for (let i = 0; i < 4; i++) cases.push(await makeCase({ title: `${word} ${i}`, createdAt: new Date(Date.UTC(2026, 0, i + 1)) }));
    await setVector(cases[0].id, at(0.99));
    const found = ids(await run(word, createRecordingProvider({ [word]: query }), { limit: 2 }));
    expect(found).toHaveLength(2);
    expect(found[0]).toBe(cases[0].id);
  });

  it("finds a public case without a vector by keywords while the provider is on", async () => {
    const { query } = axes();
    const word = token();
    const c = await makeCase({ title: `${word} has no vector` });
    expect(ids(await run(word, createRecordingProvider({ [word]: query })))).toEqual([c.id]);
  });
});

describe("when the provider cannot help", () => {
  it.each([
    ["is off", () => null],
    ["fails", () => throwingProvider],
    ["is too slow", () => slowProvider(300)],
    ["answers with the wrong size", () => ({ ...createRecordingProvider(), embed: async () => [[1, 2, 3]] }) as EmbeddingProvider],
    ["answers with no vector", () => ({ ...createRecordingProvider(), embed: async () => [] }) as EmbeddingProvider],
  ])("still answers from keywords when the provider %s", async (_label, make) => {
    const word = token();
    const c = await makeCase({ title: `${word} keyword case` });
    const started = Date.now();
    const found = await run(word, make(), { timeoutMs: 20 });
    expect(ids(found)).toEqual([c.id]);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("passes the timeout to the provider", async () => {
    const seen: Array<{ timeoutMs?: number } | undefined> = [];
    const spy: EmbeddingProvider = {
      model: MODEL,
      dimensions: 1536,
      async embed(texts, options) {
        seen.push(options);
        return texts.map(() => unitVector(1));
      },
    };
    await run(token(), spy, { timeoutMs: 777 });
    expect(seen).toEqual([{ timeoutMs: 777 }]);
  });
});

describe("what the provider is sent", () => {
  it("receives the redacted query, once, and never the secret", async () => {
    const recording = createRecordingProvider();
    await run(`error with key ${aws} in the header`, recording);
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]).toHaveLength(1);
    expect(recording.calls[0][0]).toContain("[REDACTED:aws_access_key]");
    expect(recording.received().join(" ")).not.toContain(aws);
  });

  it("receives the query without control or hidden characters", async () => {
    const recording = createRecordingProvider();
    await run("retry\u0000 loop\u200b", recording);
    expect(recording.received()).toEqual(["retry loop"]);
  });

  it("is not called at all for a query that is only a secret, or empty, and the answer is empty", async () => {
    const recording = createRecordingProvider();
    expect(await run(aws, recording)).toEqual([]);
    expect(await run("   ", recording)).toEqual([]);
    expect(recording.calls).toEqual([]);
  });

  it("does not match cases on the placeholder text", async () => {
    const c = await makeCase({ title: "Credentials in a log", summary: "The log printed [REDACTED:aws_access_key] in a header." });
    expect(ids(await run(aws, null))).not.toContain(c.id);
  });
});

describe("what a search never shows (AC-709)", () => {
  it.each(["held", "withdrawn", "rejected"] as const)("never returns a %s case, even with the nearest vector and the best match", async (status) => {
    const { query, at } = axes();
    const word = token();
    const hidden = await makeCase({ status, title: `${word} ${word} ${word}` });
    await setVector(hidden.id, at(1));
    const visible = await makeCase({ status: "open", title: `${word} visible` });
    const found = ids(await run(word, createRecordingProvider({ [word]: query })));
    expect(found).toEqual([visible.id]);
  });

  it.each(["open", "argued", "resolved", "under_appeal", "closed_unresolved"] as const)("returns a %s case found by its vector", async (status) => {
    const { query, at } = axes();
    const text = `vector for ${status} ${token()}`;
    const c = await makeCase({ status });
    await setVector(c.id, at(0.95));
    expect(ids(await run(text, createRecordingProvider({ [text]: query })))).toContain(c.id);
  });

  it("returns no vector, score, distance or similarity in any result", async () => {
    const { query, at } = axes();
    const word = token();
    const c = await makeCase({ title: `${word} shown` });
    await setVector(c.id, at(0.99));
    const found = await run(word, createRecordingProvider({ [word]: query }));
    expect(found).toHaveLength(1);
    const text = JSON.stringify(found);
    for (const forbidden of ["embedding", "vector", "score", "distance", "similarity", "rank"]) expect(text, forbidden).not.toMatch(new RegExp(`"[^"]*${forbidden}[^"]*":`, "i"));
  });
});

describe("the keyword search the public page uses", () => {
  it("finds the same cases as the search without a provider", async () => {
    const word = token();
    const a = await makeCase({ title: `${word} one` });
    const b = await makeCase({ title: `${word} two` });
    const keyword = await searchKeyword(t.db, { query: word, limit: 20 });
    expect(ids(keyword).sort()).toEqual([a.id, b.id].sort());
    expect(ids(keyword)).toEqual(ids(await run(word, null)));
  });

  it("is what the public search page calls, and the page's service knows nothing of embeddings", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/services/observerService.ts"), "utf8");
    expect(source).toContain("searchKeyword");
    expect(source).not.toMatch(/searchCases\s*\(/);
    expect(source).not.toMatch(/embed|provider/i);
  });
});
