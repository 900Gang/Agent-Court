import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EmbeddingError, type EmbeddingProvider } from "@/lib/embeddings/provider";
import { errorResponse } from "@/lib/http/errors";
import { handleCronReembed } from "@/lib/http/handlers/cron";
import { createGate } from "@/lib/safety/engine";
import { reembedStale } from "@/lib/services/embeddingService";
import { buildEmbeddingInput } from "@/lib/embeddings/input";
import { loadSecrets } from "../helpers/corpus";
import { createRecordingProvider } from "../helpers/embeddings";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const SECRET = ["cron", "secret", "value", "0123456789", "abcdef"].join("-");
const MODEL = "test-embedding-model";
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

beforeEach(async () => {
  await t.sql("reset role");
  await t.sql("truncate cases cascade");
  await t.sql("set role app_server");
});

const deps = (embedder: EmbeddingProvider | null | undefined, secret: string | null = SECRET) => ({ db: t.db, gate: createGate(), secret, embedder });
const call = (embedder: EmbeddingProvider | null | undefined, init: RequestInit & { url?: string } = {}, secret: string | null = SECRET) =>
  handleCronReembed(new Request(init.url ?? "http://localhost:3000/api/cron/reembed", init), deps(embedder, secret));
const authorized = { headers: { authorization: `Bearer ${SECRET}` } };

let clock = 0;
async function makeCase(over: Parameters<typeof f.insertCase>[1] = {}) {
  const filer = await f.makeAgent();
  clock += 1;
  return f.insertCase(filer.actor.agentId, { status: "open", title: `Case ${clock}`, summary: "A summary", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, clock)), ...over });
}

const rowCount = () => f.count("case_embeddings");
const rowsFor = (caseId: string) => t.sql(`select text_hash from case_embeddings where case_id = $1`, [caseId]);
const bodyOf = async (response: Response) => (await response.json()) as Json;
const ZERO = { disabled: false, embedded: 0, current: 0, unsafe: 0, failed: 0, remaining: 0 };

describe("the re-embed endpoint: who may call it", () => {
  const refused: Array<[string, RequestInit & { url?: string }, string | null]> = [
    ["no header", {}, SECRET],
    ["a wrong secret", { headers: { authorization: "Bearer not-the-secret" } }, SECRET],
    ["the Basic scheme", { headers: { authorization: `Basic ${SECRET}` } }, SECRET],
    ["a secret in the query string", { url: `http://localhost:3000/api/cron/reembed?secret=${SECRET}` }, SECRET],
    ["the right header when no secret is configured", authorized, null],
  ];

  it.each(refused)("answers %s with the same fixed 401, and does nothing", async (_label, init, secret) => {
    await makeCase();
    const recording = createRecordingProvider();
    const response = await call(recording, init, secret);
    const expected = errorResponse("unauthorized");
    expect(response.status).toBe(401);
    expect(response.status).toBe(expected.status);
    expect(await response.text()).toBe(await expected.text());
    expect(recording.calls).toEqual([]);
    expect(await rowCount()).toBe(0);
  });

  it("is refused the same way when no provider is configured", async () => {
    expect((await call(null)).status).toBe(401);
  });

  it.each(["GET", "POST"])("accepts %s with the right secret", async (method) => {
    expect((await call(createRecordingProvider(), { method, ...authorized })).status).toBe(200);
  });
});

describe("the re-embed endpoint: what it embeds", () => {
  it("embeds public cases that have no vector, from their stored fields, and says how many", async () => {
    const a = await makeCase({ status: "open" });
    const b = await makeCase({ status: "resolved" });
    const c = await makeCase({ status: "argued" });
    const recording = createRecordingProvider();
    const response = await call(recording, authorized);
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ...ZERO, embedded: 3 });
    expect(await rowCount()).toBe(3);
    for (const row of [a, b, c]) expect(await rowsFor(row.id)).toHaveLength(1);
    expect(recording.received().sort()).toEqual([a, b, c].map((row) => buildEmbeddingInput({ ...row, environment: row.environment })).sort());
  });

  it("re-embeds a case whose text changed after it was embedded, as after a redaction", async () => {
    const c = await makeCase();
    const recording = createRecordingProvider();
    await call(recording, authorized);
    const [before] = await rowsFor(c.id);
    await t.sql(`update cases set summary = 'A summary with [REDACTED:secret] in it' where id = $1`, [c.id]);
    expect(await bodyOf(await call(recording, authorized))).toEqual({ ...ZERO, embedded: 1 });
    const [after] = await rowsFor(c.id);
    expect(after.text_hash).not.toBe(before.text_hash);
    expect(await rowCount()).toBe(1);
  });

  it("does nothing the second time, and makes no provider call", async () => {
    await makeCase();
    await makeCase();
    const recording = createRecordingProvider();
    await call(recording, authorized);
    const callsAfterFirst = recording.calls.length;
    expect(await bodyOf(await call(recording, authorized))).toEqual(ZERO);
    expect(recording.calls).toHaveLength(callsAfterFirst);
  });

  it.each(["held", "withdrawn", "rejected"] as const)("never embeds a %s case", async (status) => {
    await makeCase({ status });
    const recording = createRecordingProvider();
    expect(await bodyOf(await call(recording, authorized))).toEqual(ZERO);
    expect(recording.calls).toEqual([]);
    expect(await rowCount()).toBe(0);
  });

  it("takes a batch at a time, oldest first, and the next call takes the rest", async () => {
    const all = [];
    for (let i = 0; i < 27; i++) all.push(await makeCase());
    const recording = createRecordingProvider();
    const first = await bodyOf(await call(recording, authorized));
    expect(first).toMatchObject({ embedded: 25, remaining: 2 });
    expect(await rowsFor(all[0].id)).toHaveLength(1);
    expect(await rowsFor(all[26].id)).toHaveLength(0);
    expect(await bodyOf(await call(recording, authorized))).toEqual({ ...ZERO, embedded: 2 });
    expect(await rowCount()).toBe(27);
    expect(await bodyOf(await call(recording, authorized))).toEqual(ZERO);
  });
});

describe("the re-embed endpoint: when things go wrong", () => {
  function failingOn(marker: string): EmbeddingProvider {
    const base = createRecordingProvider();
    return {
      model: base.model,
      dimensions: base.dimensions,
      async embed(texts, options) {
        if (texts.some((text) => text.includes(marker))) throw new EmbeddingError("http", 500);
        return base.embed(texts, options);
      },
    };
  }

  it("leaves a case the provider failed on for the next run, and embeds the others", async () => {
    const good1 = await makeCase();
    const bad = await makeCase({ title: "FAIL_ME case" });
    const good2 = await makeCase();
    const body = await bodyOf(await call(failingOn("FAIL_ME"), authorized));
    expect(body).toEqual({ ...ZERO, embedded: 2, failed: 1 });
    expect(await rowsFor(good1.id)).toHaveLength(1);
    expect(await rowsFor(good2.id)).toHaveLength(1);
    expect(await rowsFor(bad.id)).toHaveLength(0);
    expect(await bodyOf(await call(createRecordingProvider(), authorized))).toEqual({ ...ZERO, embedded: 1 });
    expect(await rowsFor(bad.id)).toHaveLength(1);
  });

  it("answers 200 with zeros and a disabled flag when no provider is configured, and embeds nothing", async () => {
    await makeCase();
    for (const embedder of [null, undefined]) {
      const response = await call(embedder, authorized);
      expect(response.status).toBe(200);
      expect(await bodyOf(response)).toEqual({ ...ZERO, disabled: true });
    }
    expect(await rowCount()).toBe(0);
  });

  it("counts a case whose stored text still holds a secret, and still embeds the others, even when it is the oldest", async () => {
    const entry = loadSecrets().find((item) => item.type === "aws_access_key" && item.evasion === undefined && item.set === "dev");
    if (!entry) throw new Error("no planted secret in the corpus");
    const unsafe = await makeCase({ summary: `Leaked: ${entry.text}` });
    const normal = [await makeCase(), await makeCase(), await makeCase()];
    const recording = createRecordingProvider();
    const body = await bodyOf(await call(recording, authorized));
    expect(body).toMatchObject({ embedded: 3, unsafe: 1, failed: 0 });
    expect(await rowsFor(unsafe.id)).toHaveLength(0);
    for (const row of normal) expect(await rowsFor(row.id)).toHaveLength(1);
    expect(recording.received().join(" ")).not.toContain(entry.secret);
  });
});

describe("what the answer holds", () => {
  it("is counts and one flag, never an id, a title, a vector or an error", async () => {
    const c = await makeCase({ title: "SENTINEL_TITLE_TEXT" });
    const response = await call(createRecordingProvider(), authorized);
    const text = await response.clone().text();
    const body = JSON.parse(text) as Json;
    expect(Object.keys(body).sort()).toEqual(["current", "disabled", "embedded", "failed", "remaining", "unsafe"]);
    for (const value of Object.values(body)) expect(["number", "boolean"]).toContain(typeof value);
    expect(text).not.toContain(c.id);
    expect(text).not.toContain("SENTINEL_TITLE_TEXT");
    expect(response.headers.get("cache-control")).toMatch(/no-store|no-cache|private/);
  });
});

describe("reembedStale", () => {
  const opts = (over: Partial<Parameters<typeof reembedStale>[2]> = {}) => ({ limit: 10, timeoutMs: 1000, deadline: Date.now() + 60_000, ...over });

  it("stops at the deadline and reports what is left", async () => {
    for (let i = 0; i < 3; i++) await makeCase();
    const recording = createRecordingProvider();
    expect(await reembedStale(t.db, recording, opts({ deadline: 0 }))).toEqual({ embedded: 0, current: 0, unsafe: 0, failed: 0, remaining: 3 });
    expect(recording.calls).toEqual([]);
  });

  it("stops between cases when the clock passes the deadline, so the rest wait for the next run", async () => {
    for (let i = 0; i < 5; i++) await makeCase();
    let now = 1000;
    const clock = () => {
      now += 100;
      return now;
    };
    const result = await reembedStale(t.db, createRecordingProvider(), opts({ deadline: 1350, clock }));
    expect(result.embedded).toBeGreaterThan(0);
    expect(result.embedded).toBeLessThan(5);
    expect(result.remaining).toBe(5 - result.embedded);
  });

  it("passes the per-call timeout to the provider", async () => {
    await makeCase();
    const seen: Array<{ timeoutMs?: number } | undefined> = [];
    const spy: EmbeddingProvider = {
      model: MODEL,
      dimensions: 1536,
      async embed(texts, options) {
        seen.push(options);
        return texts.map(() => new Array<number>(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0)));
      },
    };
    await reembedStale(t.db, spy, opts({ timeoutMs: 4321 }));
    expect(seen).toEqual([{ timeoutMs: 4321 }]);
  });

  it("does not let cases that fail the second pass use up the batch", async () => {
    const entry = loadSecrets().find((item) => item.type === "aws_access_key" && item.evasion === undefined && item.set === "dev");
    if (!entry) throw new Error("no planted secret in the corpus");
    await makeCase({ summary: `Leaked: ${entry.text}` });
    await makeCase({ summary: `Leaked again: ${entry.text}` });
    const normal = [await makeCase(), await makeCase(), await makeCase()];
    const result = await reembedStale(t.db, createRecordingProvider(), opts({ limit: 2 }));
    expect(result).toMatchObject({ embedded: 2, unsafe: 2, remaining: 1 });
    expect(await rowsFor(normal[0].id)).toHaveLength(1);
    expect(await rowsFor(normal[1].id)).toHaveLength(1);
    expect(await rowsFor(normal[2].id)).toHaveLength(0);
  });
});
