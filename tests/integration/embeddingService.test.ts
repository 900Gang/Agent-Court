import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { caseEmbeddings } from "@/db/schema";
import { buildEmbeddingInput, hashEmbeddingInput } from "@/lib/embeddings/input";
import type { EmbeddingProvider } from "@/lib/embeddings/provider";
import { embedCase, findStaleCases } from "@/lib/services/embeddingService";
import { loadSecrets } from "../helpers/corpus";
import { createRecordingProvider, throwingProvider, unitVector } from "../helpers/embeddings";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

afterEach(() => vi.restoreAllMocks());

const PUBLIC = ["open", "argued", "resolved", "under_appeal", "closed_unresolved"] as const;
const MODEL = "test-embedding-model";

async function makeCase(over: Parameters<typeof f.insertCase>[1] = {}) {
  const filer = await f.makeAgent();
  return f.insertCase(filer.actor.agentId, { status: "open", title: "Retry loop", summary: "It retries forever.", ...over });
}

const rowsFor = (caseId: string) => t.sql(`select model, dim, text_hash, vector_dims(embedding) as dims from case_embeddings where case_id = $1 order by model`, [caseId]);

const inputOf = async (caseId: string) => {
  const [row] = await t.sql(`select title, summary, expected, actual, environment, tags from cases where id = $1`, [caseId]);
  return buildEmbeddingInput(row as Parameters<typeof buildEmbeddingInput>[0]);
};

describe("embedCase", () => {
  it.each(PUBLIC)("embeds a %s case and stores one row with the model, the size and the hash", async (status) => {
    const c = await makeCase({ status });
    const recording = createRecordingProvider();
    expect(await embedCase(t.db, recording, c.id)).toEqual({ status: "embedded" });
    const expectedInput = await inputOf(c.id);
    expect(recording.calls).toEqual([[expectedInput]]);
    expect(await rowsFor(c.id)).toEqual([{ model: MODEL, dim: 1536, text_hash: hashEmbeddingInput(MODEL, expectedInput), dims: 1536 }]);
  });

  it("stores the vector the provider returned", async () => {
    const c = await makeCase();
    const recording = createRecordingProvider({ [await inputOf(c.id)]: unitVector(7) });
    await embedCase(t.db, recording, c.id);
    const [row] = await t.sql(`select embedding::text as v from case_embeddings where case_id = $1`, [c.id]);
    expect(JSON.parse(String(row.v))).toEqual(unitVector(7));
  });

  it("sends the case fields and nothing else: no evidence, no argument, no handle, no ids", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open", title: "Plain title", summary: "Plain summary" });
    await t.sql(`update evidence set redacted_text = redacted_text where false`);
    const evidence = await f.insertEvidence(c.id, "active");
    await t.sql(`update evidence set redacted_text = 'EVIDENCE_SENTINEL trace' where id = $1`, [evidence.id]);
    const other = await f.makeAgent();
    await f.insertArgument(c.id, other.actor.agentId, "active");
    await t.sql(`update arguments set reasoning = 'ARGUMENT_SENTINEL' where case_id = $1`, [c.id]);
    const recording = createRecordingProvider();
    await embedCase(t.db, recording, c.id);
    const sent = recording.received().join("\n");
    for (const forbidden of ["EVIDENCE_SENTINEL", "ARGUMENT_SENTINEL", filer.agent.handle, other.agent.handle, c.id, filer.actor.agentId, filer.actor.operatorId]) {
      expect(sent, forbidden).not.toContain(forbidden);
    }
  });

  it("does nothing for a case that is already current, and does not call the provider", async () => {
    const c = await makeCase();
    const recording = createRecordingProvider();
    await embedCase(t.db, recording, c.id);
    expect(await embedCase(t.db, recording, c.id)).toEqual({ status: "current" });
    expect(recording.calls).toHaveLength(1);
  });

  it("re-embeds a case whose text changed, and keeps one row", async () => {
    const c = await makeCase();
    const recording = createRecordingProvider();
    await embedCase(t.db, recording, c.id);
    const [before] = await rowsFor(c.id);
    await t.sql(`update cases set summary = 'A redacted summary with [REDACTED:secret] in it' where id = $1`, [c.id]);
    expect(await embedCase(t.db, recording, c.id)).toEqual({ status: "embedded" });
    const rows = await rowsFor(c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].text_hash).not.toBe(before.text_hash);
    expect(rows[0].text_hash).toBe(hashEmbeddingInput(MODEL, await inputOf(c.id)));
    expect(recording.calls).toHaveLength(2);
  });

  it.each(["held", "withdrawn", "rejected"] as const)("never embeds a %s case, and sends nothing", async (status) => {
    const c = await makeCase({ status });
    const recording = createRecordingProvider();
    expect(await embedCase(t.db, recording, c.id)).toEqual({ status: "not_public" });
    expect(recording.calls).toEqual([]);
    expect(await rowsFor(c.id)).toEqual([]);
  });

  it.each([[crypto.randomUUID()], ["not-a-uuid"], [""], ["'; drop table cases; --"]])("answers not_public for the id %j, without throwing", async (id) => {
    const recording = createRecordingProvider();
    expect(await embedCase(t.db, recording, id)).toEqual({ status: "not_public" });
    expect(recording.calls).toEqual([]);
  });

  it("keeps a second row for a second model", async () => {
    const c = await makeCase();
    await embedCase(t.db, createRecordingProvider(), c.id);
    const other: EmbeddingProvider = { ...createRecordingProvider(), model: "other-model" };
    expect(await embedCase(t.db, other, c.id)).toEqual({ status: "embedded" });
    expect((await rowsFor(c.id)).map((row) => row.model)).toEqual(["other-model", MODEL]);
  });

  it("passes the timeout it was given to the provider", async () => {
    const c = await makeCase();
    const seen: Array<{ timeoutMs?: number } | undefined> = [];
    const spy: EmbeddingProvider = {
      model: MODEL,
      dimensions: 1536,
      async embed(texts, options) {
        seen.push(options);
        return texts.map(() => unitVector(1));
      },
    };
    await embedCase(t.db, spy, c.id, { timeoutMs: 1234 });
    expect(seen).toEqual([{ timeoutMs: 1234 }]);
  });
});

describe("embedCase: failures change nothing", () => {
  it("reports a provider failure, writes nothing and keeps an older row", async () => {
    const c = await makeCase();
    await embedCase(t.db, createRecordingProvider(), c.id);
    const [before] = await rowsFor(c.id);
    await t.sql(`update cases set title = 'A new title' where id = $1`, [c.id]);
    expect(await embedCase(t.db, throwingProvider, c.id)).toEqual({ status: "failed" });
    expect((await rowsFor(c.id))[0].text_hash).toBe(before.text_hash);
  });

  it("writes no row when the provider fails on a case that has none", async () => {
    const c = await makeCase();
    expect(await embedCase(t.db, throwingProvider, c.id)).toEqual({ status: "failed" });
    expect(await rowsFor(c.id)).toEqual([]);
  });

  it.each([
    ["a vector of the wrong length", async (texts: string[]) => texts.map(() => [1, 2, 3])],
    ["fewer vectors than texts", async () => []],
    ["more vectors than texts", async (texts: string[]) => [...texts, "extra"].map(() => unitVector(1))],
    ["a vector with a value that is not a number", async (texts: string[]) => texts.map(() => [...unitVector(1).slice(1), Number.NaN])],
  ])("treats %s as a failure and writes nothing", async (_label, answer) => {
    const c = await makeCase();
    const bad: EmbeddingProvider = { model: MODEL, dimensions: 1536, embed: answer };
    expect(await embedCase(t.db, bad, c.id)).toEqual({ status: "failed" });
    expect(await rowsFor(c.id)).toEqual([]);
  });
});

describe("embedCase: the second redaction pass (threat T8)", () => {
  const TYPES = ["aws_access_key", "github_token", "openai_key", "stripe_key", "slack_token", "jwt"];
  const planted = loadSecrets().filter((entry) => TYPES.includes(entry.type) && entry.evasion === undefined && entry.set === "dev");

  it("has a planted secret of several types to work with", () => {
    expect(new Set(planted.map((entry) => entry.type)).size).toBeGreaterThanOrEqual(4);
  });

  it("refuses a case whose stored text still holds a secret, for each type, and sends nothing", async () => {
    const seen = new Set<string>();
    for (const entry of planted) {
      if (seen.has(entry.type)) continue;
      seen.add(entry.type);
      const c = await makeCase({ summary: `The failing call logged this: ${entry.text}` });
      const recording = createRecordingProvider();
      expect(await embedCase(t.db, recording, c.id), entry.type).toEqual({ status: "unsafe" });
      expect(recording.calls, entry.type).toEqual([]);
      expect(await rowsFor(c.id), entry.type).toEqual([]);
    }
  });

  it("refuses a secret in any of the embedded fields, not only the summary", async () => {
    const entry = planted[0];
    for (const field of ["title", "expected", "actual"] as const) {
      const c = await makeCase({ [field]: `Printed ${entry.text}` });
      const recording = createRecordingProvider();
      expect(await embedCase(t.db, recording, c.id), field).toEqual({ status: "unsafe" });
      expect(recording.calls).toEqual([]);
    }
    const inEnvironment = await makeCase({ environment: { model: entry.text } });
    expect(await embedCase(t.db, createRecordingProvider(), inEnvironment.id)).toEqual({ status: "unsafe" });
    const inTags = await makeCase({ tags: ["plain-tag"] });
    expect(await embedCase(t.db, createRecordingProvider(), inTags.id)).toEqual({ status: "embedded" });
  });

  it("logs the case id and the rule names, and never the secret", async () => {
    const entry = planted[0];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const c = await makeCase({ summary: `Leaked: ${entry.text}` });
    await embedCase(t.db, createRecordingProvider(), c.id);
    const logged = spies.flatMap((spy) => spy.mock.calls.flat()).join("\n");
    expect(logged).toContain(c.id);
    expect(logged).toContain(entry.type);
    expect(logged).not.toContain(entry.secret);
  });

  it("sends text that holds placeholders only, with none of the plain secrets in it", async () => {
    const c = await makeCase({
      summary: "The failing call logged [REDACTED:aws_access_key] and [REDACTED:github_token] in clear text.",
      title: "Credentials in a log line",
    });
    const recording = createRecordingProvider();
    expect(await embedCase(t.db, recording, c.id)).toEqual({ status: "embedded" });
    const sent = recording.received().join("\n");
    expect(sent).toContain("[REDACTED:aws_access_key]");
    for (const entry of loadSecrets()) expect(sent, entry.id).not.toContain(entry.secret);
  });

  it("refuses text with hidden characters left in it", async () => {
    const c = await makeCase({ title: "A title with a zero\u200bwidth space" });
    const recording = createRecordingProvider();
    expect(await embedCase(t.db, recording, c.id)).toEqual({ status: "unsafe" });
    expect(recording.calls).toEqual([]);
  });
});

describe("findStaleCases", () => {
  let t2: TestDb;
  let f2: ReturnType<typeof createFixtures>;

  beforeAll(async () => {
    t2 = await createTestDb();
    await t2.sql("set role app_server");
    f2 = createFixtures(t2);
  });

  afterAll(async () => {
    await t2.sql("reset role");
    await t2.close();
  });

  const day = (n: number) => new Date(Date.UTC(2026, 0, n));

  it("lists public cases with no vector or an old one, oldest first, and leaves out the rest", async () => {
    const filer = await f2.makeAgent();
    const make = (over: Parameters<typeof f2.insertCase>[1]) => f2.insertCase(filer.actor.agentId, { title: "T", summary: "S", ...over });
    const missingNew = await make({ status: "open", createdAt: day(5) });
    const missingOld = await make({ status: "resolved", createdAt: day(1) });
    const current = await make({ status: "open", createdAt: day(2) });
    const stale = await make({ status: "argued", createdAt: day(3) });
    const held = await make({ status: "held", createdAt: day(0) });
    const withdrawn = await make({ status: "withdrawn", createdAt: day(0) });
    const rejected = await make({ status: "rejected", createdAt: day(0) });
    const recording = createRecordingProvider();
    await embedCase(t2.db, recording, current.id);
    await embedCase(t2.db, recording, stale.id);
    await t2.sql(`update cases set title = 'Changed after it was embedded' where id = $1`, [stale.id]);

    const ids = await findStaleCases(t2.db, MODEL, 100);
    expect(ids).toEqual([missingOld.id, stale.id, missingNew.id]);
    for (const hidden of [held, withdrawn, rejected, current]) expect(ids).not.toContain(hidden.id);
  });

  it("caps the list at the limit", async () => {
    expect((await findStaleCases(t2.db, MODEL, 2)).length).toBe(2);
    expect(await findStaleCases(t2.db, MODEL, 0)).toEqual([]);
  });

  it("counts a vector from another model as missing", async () => {
    const [{ id }] = await t2.db.select({ id: caseEmbeddings.caseId }).from(caseEmbeddings).limit(1);
    expect(await findStaleCases(t2.db, "a-model-nobody-used", 100)).toContain(id);
  });

  it("returns ids only, never text or vectors", async () => {
    const ids = await findStaleCases(t2.db, MODEL, 100);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
