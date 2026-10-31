import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiScope } from "@/lib/config/constants";
import type { EmbeddingProvider } from "@/lib/embeddings/provider";
import type { ApiDeps } from "@/lib/http/apiPipeline";
import { handleListCases, handleSearchCases } from "@/lib/http/handlers/cases";
import { registerCourtTools } from "@/lib/mcp/tools";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import type { RateLimiter } from "@/lib/ratelimit/limiter";
import { issueKey } from "@/lib/services/keyService";
import { createRecordingProvider, throwingProvider, unitVector } from "../helpers/embeddings";
import { passGate } from "../helpers/gates";
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

const DAY = 86_400_000;
const now = new Date(Date.now() + 30 * DAY);
const aws = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const MODEL = "test-embedding-model";

const deps = (over: Partial<ApiDeps> = {}): ApiDeps => ({
  db: t.db,
  limiter: createMemoryLimiter(() => now.getTime()),
  gate: passGate,
  writesEnabled: true,
  now,
  ...over,
});

async function agentWithKey(scopes: ApiScope[] = ["read"]) {
  const made = await f.makeAgent();
  const issued = f.unwrap(await issueKey(t.db, made.operator, made.agent.id, { scopes }));
  return { ...made, key: issued.key };
}

const request = (key: string | null, query: string) =>
  new Request(`http://localhost:3000/api/v1/cases/search${query}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
const q = (text: string, extra = "") => `?q=${encodeURIComponent(text)}${extra}`;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const token = () => f.uniq("sev").replace(/-/g, "x");
const eventCount = () => f.count("search_events");
const lastEvents = (n: number) => t.sql(`select agent_id, query_redacted, result_count, resolved_hit from search_events order by created_at desc, id desc limit ${n}`);

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

async function setVector(caseId: string, vector: number[]) {
  await t.sql(`insert into case_embeddings (case_id, model, dim, embedding, text_hash) values ($1, $2, 1536, $3::vector, 'h')`, [caseId, MODEL, `[${vector.join(",")}]`]);
}

async function makeCase(over: Parameters<typeof f.insertCase>[1] = {}) {
  const filer = await f.makeAgent();
  return f.insertCase(filer.actor.agentId, { status: "open", title: "Unrelated title", summary: "Unrelated summary", ...over });
}

function consoleOutput() {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
  return () => spies.flatMap((spy) => spy.mock.calls.flat()).join("\n");
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
  return [];
}

describe("a search writes one event", () => {
  it("records the agent, the query, how many cases came back and whether one was resolved", async () => {
    const reader = await agentWithKey();
    const word = token();
    await makeCase({ status: "resolved", title: `${word} fixed` });
    await makeCase({ status: "open", title: `${word} open` });
    const before = await eventCount();
    const response = await handleSearchCases(request(reader.key, q(word)), deps());
    expect(response.status).toBe(200);
    expect(await eventCount()).toBe(before + 1);
    expect(await lastEvents(1)).toEqual([{ agent_id: reader.agent.id, query_redacted: word, result_count: 2, resolved_hit: true }]);
  });

  it("says resolved_hit is false when no resolved case came back, and counts what the limit left", async () => {
    const reader = await agentWithKey();
    const word = token();
    for (let i = 0; i < 3; i++) await makeCase({ status: "open", title: `${word} ${i}` });
    await handleSearchCases(request(reader.key, q(word, "&limit=2")), deps());
    expect(await lastEvents(1)).toEqual([{ agent_id: reader.agent.id, query_redacted: word, result_count: 2, resolved_hit: false }]);
  });

  it("records a search that found nothing, with a count of zero", async () => {
    const reader = await agentWithKey();
    const word = token();
    await handleSearchCases(request(reader.key, q(word)), deps());
    expect(await lastEvents(1)).toEqual([{ agent_id: reader.agent.id, query_redacted: word, result_count: 0, resolved_hit: false }]);
  });

  it("writes one row per search, not one per case or per leg", async () => {
    const reader = await agentWithKey();
    const word = token();
    await makeCase({ title: `${word} a` });
    const before = await eventCount();
    await handleSearchCases(request(reader.key, q(word)), deps());
    await handleSearchCases(request(reader.key, q(word)), deps());
    expect(await eventCount()).toBe(before + 2);
  });

  it("stores the query cleaned: no control or hidden characters", async () => {
    const reader = await agentWithKey();
    await handleSearchCases(request(reader.key, q("retry\u0000 loop\u200b")), deps());
    expect((await lastEvents(1))[0].query_redacted).toBe("retry loop");
  });

  it("is not written by the other read routes", async () => {
    const reader = await agentWithKey();
    const before = await eventCount();
    const response = await handleListCases(new Request("http://localhost:3000/api/v1/cases", { headers: { authorization: `Bearer ${reader.key}` } }), deps());
    expect(response.status).toBe(200);
    expect(await eventCount()).toBe(before);
  });
});

describe("a secret in a query (threats T8 and T10)", () => {
  it("never reaches the table, the provider, a log line or the answer", async () => {
    const reader = await agentWithKey();
    const output = consoleOutput();
    const recording = createRecordingProvider();
    const text = `error with key ${aws} in the header`;
    const response = await handleSearchCases(request(reader.key, q(text)), deps({ embedder: recording }));
    expect(response.status).toBe(200);
    const body = await response.text();

    const [event] = await lastEvents(1);
    expect(event.query_redacted).toContain("[REDACTED:aws_access_key]");
    expect(event.query_redacted).not.toContain(aws);
    const wholeTable = await t.sql(`select count(*)::int as n from search_events e where e::text like $1`, [`%${aws}%`]);
    expect(wholeTable[0].n).toBe(0);
    expect(recording.received().join(" ")).toContain("[REDACTED:aws_access_key]");
    expect(recording.received().join(" ")).not.toContain(aws);
    expect(output()).not.toContain(aws);
    expect(body).not.toContain(aws);
  });

  it("is still logged when the query is nothing but a secret, as a placeholder, with no provider call", async () => {
    const reader = await agentWithKey();
    const recording = createRecordingProvider();
    const response = await handleSearchCases(request(reader.key, q(aws)), deps({ embedder: recording }));
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text()).cases).toEqual([]);
    expect(recording.calls).toEqual([]);
    const [event] = await lastEvents(1);
    expect(event.query_redacted).not.toContain(aws);
    expect(event.result_count).toBe(0);
  });
});

describe("a search that fails writes nothing", () => {
  it.each([
    ["no q", ""],
    ["a blank q", "?q=%20%20"],
    ["a q over 200 characters", `?q=${"a".repeat(201)}`],
    ["a limit of 0", "?q=word&limit=0"],
    ["a limit over the maximum", "?q=word&limit=999"],
  ])("%s", async (_label, query) => {
    const reader = await agentWithKey();
    const before = await eventCount();
    const response = await handleSearchCases(request(reader.key, query), deps());
    expect(response.status).toBe(400);
    expect(await eventCount()).toBe(before);
  });

  it("no key", async () => {
    const before = await eventCount();
    expect((await handleSearchCases(request(null, q("word")), deps())).status).toBe(401);
    expect(await eventCount()).toBe(before);
  });

  it("a key without the read scope", async () => {
    const writer = await agentWithKey(["cases:write"]);
    const before = await eventCount();
    expect((await handleSearchCases(request(writer.key, q("word")), deps())).status).toBe(403);
    expect(await eventCount()).toBe(before);
  });

  it("a request the rate limit refuses", async () => {
    const reader = await agentWithKey();
    const refusing: RateLimiter = { check: async (_id, limit) => ({ allowed: false, limit, remaining: 0, resetAt: now.getTime() + 7000, retryAfterSeconds: 7 }) };
    const before = await eventCount();
    expect((await handleSearchCases(request(reader.key, q("word")), deps({ limiter: refusing }))).status).toBe(429);
    expect(await eventCount()).toBe(before);
  });
});

describe("a log that cannot be written does not change the answer", () => {
  it("answers as usual and logs only the kind of error", async () => {
    const reader = await agentWithKey();
    const output = consoleOutput();
    const word = token();
    const c = await makeCase({ title: `${word} shown` });
    const failingInsert = new Proxy(t.db, {
      get(target, property, receiver) {
        if (property === "insert") {
          return () => {
            throw new Error("boom SENTINEL_DB_ERROR");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const response = await handleSearchCases(request(reader.key, q(word)), deps({ db: failingInsert }));
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text()).cases.map((entry: Json) => entry.id)).toEqual([c.id]);
    expect(output()).not.toContain("SENTINEL_DB_ERROR");
  });
});

describe("the answer", () => {
  it("is the same list envelope as before, with no vector, score or distance", async () => {
    const reader = await agentWithKey();
    const { query, at } = axes();
    const word = token();
    const c = await makeCase({ title: `${word} shown` });
    await setVector(c.id, at(0.99));
    const response = await handleSearchCases(request(reader.key, q(word)), deps({ embedder: createRecordingProvider({ [word]: query }) }));
    const body = JSON.parse(await response.text()) as Json;
    expect(body.cases.map((entry: Json) => entry.id)).toEqual([c.id]);
    for (const entry of body.cases) expect(entry.untrusted_content).toBeDefined();
    for (const key of keysOf(body)) expect(key, key).not.toMatch(/embedding|vector|score|distance|similarity|rank/i);
  });

  it("finds a case by meaning when a provider is configured", async () => {
    const reader = await agentWithKey();
    const { query, at } = axes();
    const text = `semantic route ${token()}`;
    const paraphrase = await makeCase({ title: "Agent hammers the API after being throttled" });
    await setVector(paraphrase.id, at(0.95));
    const response = await handleSearchCases(request(reader.key, q(text)), deps({ embedder: createRecordingProvider({ [text]: query }) }));
    expect(JSON.parse(await response.text()).cases.map((entry: Json) => entry.id)).toContain(paraphrase.id);
    expect((await lastEvents(1))[0].result_count).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["no provider", () => null],
    ["no provider property at all", () => undefined],
    ["a provider that fails", () => throwingProvider],
  ])("still answers from keywords, and still logs, with %s", async (_label, make) => {
    const reader = await agentWithKey();
    const word = token();
    const c = await makeCase({ title: `${word} keyword case` });
    const before = await eventCount();
    const response = await handleSearchCases(request(reader.key, q(word)), deps({ embedder: make() as EmbeddingProvider | null | undefined }));
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text()).cases.map((entry: Json) => entry.id)).toEqual([c.id]);
    expect(await eventCount()).toBe(before + 1);
  });
});

describe("the MCP search tool", () => {
  async function connect(key: string, over: Partial<ApiDeps> = {}): Promise<Client> {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    registerCourtTools(server, { authorization: `Bearer ${key}`, deps: deps(over) });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    clients.push(client);
    return client;
  }

  it("uses the same search: meaning, redaction and one logged event", async () => {
    const reader = await agentWithKey();
    const { query, at } = axes();
    const text = `semantic tool ${token()}`;
    const paraphrase = await makeCase({ title: "A rewording with different words" });
    await setVector(paraphrase.id, at(0.95));
    const client = await connect(reader.key, { embedder: createRecordingProvider({ [text]: query }) });
    const before = await eventCount();
    const result = (await client.callTool({ name: "court_search_precedents", arguments: { query: text } })) as { structuredContent?: Json; isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.cases.map((entry: Json) => entry.id)).toContain(paraphrase.id);
    expect(await eventCount()).toBe(before + 1);
    expect((await lastEvents(1))[0].agent_id).toBe(reader.agent.id);
    for (const key of keysOf(result.structuredContent)) expect(key, key).not.toMatch(/embedding|vector|score|distance|similarity|rank/i);
  });

  it("never sends a secret in the query to the provider or the table", async () => {
    const reader = await agentWithKey();
    const recording = createRecordingProvider();
    const client = await connect(reader.key, { embedder: recording });
    await client.callTool({ name: "court_search_precedents", arguments: { query: `error with key ${aws} in the header` } });
    expect(recording.received().join(" ")).not.toContain(aws);
    const wholeTable = await t.sql(`select count(*)::int as n from search_events e where e::text like $1`, [`%${aws}%`]);
    expect(wholeTable[0].n).toBe(0);
  });
});
