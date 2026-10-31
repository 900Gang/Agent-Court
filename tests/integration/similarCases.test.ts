import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { operators, type Operator } from "@/db/schema";
import { moderateCore } from "@/lib/admin/actionsCore";
import { SEARCH_TUNING, type ApiScope } from "@/lib/config/constants";
import type { ActionDeps } from "@/lib/dashboard/actionsCore";
import { buildEmbeddingInput } from "@/lib/embeddings/input";
import type { EmbeddingProvider } from "@/lib/embeddings/provider";
import type { ApiDeps } from "@/lib/http/apiPipeline";
import { handleFileCase } from "@/lib/http/handlers/cases";
import { registerCourtTools } from "@/lib/mcp/tools";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import type { SafetyGate } from "@/lib/safety/gate";
import { issueKey } from "@/lib/services/keyService";
import { blockGate, flagGate, passGate } from "../helpers/gates";
import { createRecordingProvider, slowProvider, throwingProvider, unitVector } from "../helpers/embeddings";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
let nextAxis = 0;
const clients: Client[] = [];

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.close();
});

const MODEL = "test-embedding-model";
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const deps = (gate: SafetyGate = passGate, over: Partial<ApiDeps> = {}): ApiDeps => ({
  db: t.db,
  limiter: createMemoryLimiter(),
  gate,
  writesEnabled: true,
  ...over,
});

async function agentWithKey(scopes: ApiScope[] = ["read", "cases:write", "arguments:write"]) {
  const made = await f.makeAgent();
  const issued = f.unwrap(await issueKey(t.db, made.operator, made.agent.id, { scopes }));
  return { ...made, key: issued.key };
}

const fields = (tag: string) => ({
  title: "MARK_title",
  summary: "MARK_summary",
  expected: "MARK_expected",
  actual: "MARK_actual",
  tags: [tag],
  environment: { model: "model-a" },
  evidence: [{ kind: "trace", text: "MARK_evidence" }],
});

/** The text the service will embed for a case filed with `fields(tag)`. */
const inputFor = (tag: string) => buildEmbeddingInput({ ...fields(tag), environment: { model: "model-a" } });

function request(key: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/v1/cases", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function file(a: { key: string }, d: ApiDeps, tag: string, headers: Record<string, string> = {}) {
  const response = await handleFileCase(request(a.key, fields(tag), headers), d);
  return { response, body: (await response.clone().json()) as Json };
}

const tagOf = () => f.uniq("sim").replace(/-/g, "");

/** A pair of axes of its own, so vectors from other tests are orthogonal to this test's query and never match. */
function axes() {
  const a = nextAxis;
  nextAxis += 2;
  return {
    query: unitVector(a),
    at: (c: number) => {
      const vector = new Array<number>(1536).fill(0);
      vector[a] = c;
      vector[a + 1] = Math.sqrt(Math.max(0, 1 - c * c));
      return vector;
    },
  };
}

async function setVector(caseId: string, vector: number[], model = MODEL) {
  await t.sql(`insert into case_embeddings (case_id, model, dim, embedding, text_hash) values ($1, $2, 1536, $3::vector, 'h')`, [caseId, model, `[${vector.join(",")}]`]);
}

async function neighbour(status: Parameters<typeof f.insertCase>[1], cosine: number, at: (c: number) => number[], title = "MARK_neighbour_title") {
  const filer = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { title, summary: "MARK_neighbour_summary", ...status });
  await setVector(c.id, at(cosine));
  return c;
}

const rowsFor = (caseId: string) => t.sql(`select model, text_hash from case_embeddings where case_id = $1`, [caseId]);
const ids = (list: Json[]) => list.map((entry) => entry.id);

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
  return [];
}

function leaves(value: unknown, path: string[] = []): Array<{ path: string[]; value: unknown }> {
  if (Array.isArray(value)) return value.flatMap((item, i) => leaves(item, [...path, String(i)]));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
  return [{ path, value }];
}

describe("the tuning for similar cases", () => {
  it("returns at most three, above a bar of 0.4", () => {
    expect(SEARCH_TUNING.similarLimit).toBe(3);
    expect(SEARCH_TUNING.minSimilarity).toBeGreaterThanOrEqual(0.3);
  });
});

describe("filing a case: similar_resolved", () => {
  it("embeds the new case and returns the nearest resolved cases above the bar, nearest first, at most three", async () => {
    const a = await agentWithKey();
    const { query, at } = axes();
    const tag = tagOf();
    const far = await neighbour({ status: "resolved" }, 0.55, at);
    const nearest = await neighbour({ status: "resolved" }, 0.95, at);
    const near = await neighbour({ status: "resolved" }, 0.8, at);
    const middling = await neighbour({ status: "resolved" }, 0.45, at);
    const tooFar = await neighbour({ status: "resolved" }, 0.2, at);
    const recording = createRecordingProvider({ [inputFor(tag)]: query });

    const { response, body } = await file(a, deps(passGate, { embedder: recording }), tag);
    expect(response.status).toBe(201);
    expect(ids(body.similar_resolved)).toEqual([nearest.id, near.id, far.id]);
    for (const left of [middling, tooFar]) expect(ids(body.similar_resolved)).not.toContain(left.id);
    expect(body.case.status).toBe("open");

    const rows = await rowsFor(body.case.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe(MODEL);
    expect(recording.calls).toEqual([[inputFor(tag)]]);
  });

  it("returns resolved cases only, however near the others are", async () => {
    const a = await agentWithKey();
    const { query, at } = axes();
    const tag = tagOf();
    const resolved = await neighbour({ status: "resolved" }, 0.6, at);
    for (const status of ["open", "argued", "under_appeal", "closed_unresolved"] as const) await neighbour({ status }, 0.99, at);
    const { body } = await file(a, deps(passGate, { embedder: createRecordingProvider({ [inputFor(tag)]: query }) }), tag);
    expect(ids(body.similar_resolved)).toEqual([resolved.id]);
  });

  it("never returns the case that was just filed, and never a vector from another model", async () => {
    const a = await agentWithKey();
    const { query, at } = axes();
    const tag = tagOf();
    const otherModel = await neighbour({ status: "resolved" }, 0.99, at);
    await t.sql(`update case_embeddings set model = 'some-older-model' where case_id = $1`, [otherModel.id]);
    const { body } = await file(a, deps(passGate, { embedder: createRecordingProvider({ [inputFor(tag)]: query }) }), tag);
    expect(ids(body.similar_resolved)).not.toContain(body.case.id);
    expect(ids(body.similar_resolved)).not.toContain(otherModel.id);
  });

  it("gives list views with their text under untrusted_content, and no vector, score or distance", async () => {
    const a = await agentWithKey();
    const { query, at } = axes();
    const tag = tagOf();
    const resolved = await neighbour({ status: "resolved" }, 0.9, at);
    const { body } = await file(a, deps(passGate, { embedder: createRecordingProvider({ [inputFor(tag)]: query }) }), tag);
    expect(body.similar_resolved).toHaveLength(1);
    const [entry] = body.similar_resolved;
    expect(entry).toMatchObject({ id: resolved.id, status: "resolved" });
    expect(entry.untrusted_content.title).toBe("MARK_neighbour_title");
    for (const key of keysOf(body)) expect(key, key).not.toMatch(/embedding|vector|score|distance|similarity|rank/i);
  });

  it("keeps every marked string inside untrusted_content, and the notice, as the envelope rule says (AC-307)", async () => {
    const a = await agentWithKey();
    const { query, at } = axes();
    const tag = tagOf();
    await neighbour({ status: "resolved" }, 0.9, at);
    const { body } = await file(a, deps(passGate, { embedder: createRecordingProvider({ [inputFor(tag)]: query }) }), tag);
    expect(typeof body.notice).toBe("string");
    for (const leaf of leaves(body)) {
      if (typeof leaf.value === "string" && leaf.value.includes("MARK_")) expect(leaf.path, leaf.path.join(".")).toContain("untrusted_content");
    }
  });

  it("is an empty list when nothing is similar", async () => {
    const a = await agentWithKey();
    const { query } = axes();
    const tag = tagOf();
    const { response, body } = await file(a, deps(passGate, { embedder: createRecordingProvider({ [inputFor(tag)]: query }) }), tag);
    expect(response.status).toBe(201);
    expect(body.similar_resolved).toEqual([]);
  });
});

describe("filing a case: when there is nothing to embed or no one to ask", () => {
  it("a case held for review gets no embedding, no provider call and an empty list", async () => {
    const a = await agentWithKey();
    const { query, at } = axes();
    const tag = tagOf();
    await neighbour({ status: "resolved" }, 0.95, at);
    const recording = createRecordingProvider({ [inputFor(tag)]: query });
    const { response, body } = await file(a, deps(flagGate, { embedder: recording }), tag);
    expect(response.status).toBe(202);
    expect(body.similar_resolved).toEqual([]);
    expect(body.case.status).toBe("held");
    expect(recording.calls).toEqual([]);
    expect(await rowsFor(body.case.id)).toEqual([]);
  });

  it("a case the gate blocks is the same 422 as before, with no provider call", async () => {
    const a = await agentWithKey();
    const recording = createRecordingProvider();
    const { response } = await file(a, deps(blockGate, { embedder: recording }), tagOf());
    expect(response.status).toBe(422);
    expect(recording.calls).toEqual([]);
  });

  it("an invalid body is a 400 with no provider call", async () => {
    const a = await agentWithKey();
    const recording = createRecordingProvider();
    const response = await handleFileCase(request(a.key, { title: "only a title" }), deps(passGate, { embedder: recording }));
    expect(response.status).toBe(400);
    expect(recording.calls).toEqual([]);
  });

  it.each([
    ["no provider", () => null],
    ["no provider property at all", () => undefined],
    ["a provider that fails", () => throwingProvider],
    ["a provider that answers with the wrong size", () => ({ ...createRecordingProvider(), embed: async () => [[1, 2, 3]] }) as EmbeddingProvider],
    ["a provider that answers with nothing", () => ({ ...createRecordingProvider(), embed: async () => [] }) as EmbeddingProvider],
  ])("still files the case, with an empty list, with %s", async (_label, make) => {
    const a = await agentWithKey();
    const { response, body } = await file(a, deps(passGate, { embedder: make() as EmbeddingProvider | null | undefined }), tagOf());
    expect(response.status).toBe(201);
    expect(body.similar_resolved).toEqual([]);
    expect(body.case.status).toBe("open");
    expect(await rowsFor(body.case.id)).toEqual([]);
  });

  it("waits no longer than the timeout for a slow provider", async () => {
    const a = await agentWithKey();
    const started = Date.now();
    const { response, body } = await file(a, deps(passGate, { embedder: slowProvider(500), embedTimeoutMs: 30 }), tagOf());
    expect(response.status).toBe(201);
    expect(body.similar_resolved).toEqual([]);
    expect(Date.now() - started).toBeLessThan(400);
  });
});

describe("filing a case: a retry", () => {
  it("returns the identical body, similar cases included, and does not embed again", async () => {
    const a = await agentWithKey();
    const { query, at } = axes();
    const tag = tagOf();
    const resolved = await neighbour({ status: "resolved" }, 0.9, at);
    const recording = createRecordingProvider({ [inputFor(tag)]: query });
    const d = deps(passGate, { embedder: recording });
    const key = `retry-key-${tag}`;
    const first = await file(a, d, tag, { "idempotency-key": key });
    const second = await file(a, d, tag, { "idempotency-key": key });
    expect(first.response.status).toBe(201);
    expect(second.response.headers.get("idempotent-replay")).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(ids(second.body.similar_resolved)).toEqual([resolved.id]);
    expect(recording.calls).toHaveLength(1);
    expect(await rowsFor(first.body.case.id)).toHaveLength(1);
  });
});

describe("the MCP file tool", () => {
  async function connect(key: string, over: Partial<ApiDeps> = {}): Promise<Client> {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerCourtTools(server, { authorization: `Bearer ${key}`, deps: deps(passGate, over) });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    clients.push(client);
    return client;
  }

  it("returns similar_resolved in the tool result, as the REST route does", async () => {
    const a = await agentWithKey();
    const { query, at } = axes();
    const tag = tagOf();
    const resolved = await neighbour({ status: "resolved" }, 0.9, at);
    const client = await connect(a.key, { embedder: createRecordingProvider({ [inputFor(tag)]: query }) });
    const result = (await client.callTool({ name: "court_file_case", arguments: fields(tag) })) as { structuredContent?: Json; isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(ids(result.structuredContent?.similar_resolved)).toEqual([resolved.id]);
    for (const key of keysOf(result.structuredContent)) expect(key, key).not.toMatch(/embedding|vector|score|distance|similarity|rank/i);
  });
});

describe("an admin approving a held case", () => {
  const ORIGIN = "http://localhost:3000";

  async function admin(): Promise<Operator> {
    const [row] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Admin", role: "admin", status: "active" }).returning();
    return row;
  }

  const actionDeps = (operator: Operator | null, over: Partial<ActionDeps> = {}): ActionDeps => ({
    db: t.db,
    operator,
    headers: new Headers({ origin: ORIGIN }),
    expectedOrigin: ORIGIN,
    ...over,
  });

  async function heldCase() {
    const filer = await f.makeAgent();
    return f.insertCase(filer.actor.agentId, { status: "held", title: "A held case", summary: "Waiting for review" });
  }

  const inputOf = async (caseId: string) => {
    const [row] = await t.sql(`select title, summary, expected, actual, environment, tags from cases where id = $1`, [caseId]);
    return buildEmbeddingInput(row as Parameters<typeof buildEmbeddingInput>[0]);
  };

  it("embeds the case once it is public, from the text a visitor can see", async () => {
    const c = await heldCase();
    const recording = createRecordingProvider();
    const result = await moderateCore(actionDeps(await admin(), { embedder: recording }), { kind: "case", id: c.id, decision: "approve" });
    expect(result).toEqual({ ok: true, value: { status: "open" } });
    expect(recording.calls).toEqual([[await inputOf(c.id)]]);
    expect(await rowsFor(c.id)).toHaveLength(1);
  });

  it.each([
    ["a provider that fails", () => throwingProvider],
    ["no provider", () => null],
    ["no provider property at all", () => undefined],
  ])("still approves it, with %s", async (_label, make) => {
    const c = await heldCase();
    const result = await moderateCore(actionDeps(await admin(), { embedder: make() as EmbeddingProvider | null | undefined }), { kind: "case", id: c.id, decision: "approve" });
    expect(result).toEqual({ ok: true, value: { status: "open" } });
    expect(await rowsFor(c.id)).toEqual([]);
  });

  it("embeds nothing when the case is rejected, or when the item is evidence or an argument", async () => {
    const recording = createRecordingProvider();
    const operator = await admin();
    const rejected = await heldCase();
    expect((await moderateCore(actionDeps(operator, { embedder: recording }), { kind: "case", id: rejected.id, decision: "reject" })).ok).toBe(true);
    const publicCase = await heldCase();
    await t.sql(`update cases set status = 'open' where id = $1`, [publicCase.id]);
    const evidence = await f.insertEvidence(publicCase.id, "held");
    expect((await moderateCore(actionDeps(operator, { embedder: recording }), { kind: "evidence", id: evidence.id, decision: "approve" })).ok).toBe(true);
    const author = await f.makeAgent();
    const argument = await f.insertArgument(publicCase.id, author.actor.agentId, "held");
    expect((await moderateCore(actionDeps(operator, { embedder: recording }), { kind: "argument", id: argument.id, decision: "approve" })).ok).toBe(true);
    expect(recording.calls).toEqual([]);
  });

  it("embeds nothing for someone who is not an admin, or a request from another site", async () => {
    const recording = createRecordingProvider();
    const c = await heldCase();
    const [ordinary] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Op", role: "operator", status: "active" }).returning();
    expect((await moderateCore(actionDeps(ordinary, { embedder: recording }), { kind: "case", id: c.id, decision: "approve" })).ok).toBe(false);
    expect((await moderateCore(actionDeps(await admin(), { embedder: recording, headers: new Headers({ origin: "https://evil.example" }) }), { kind: "case", id: c.id, decision: "approve" })).ok).toBe(false);
    expect(recording.calls).toEqual([]);
  });
});
