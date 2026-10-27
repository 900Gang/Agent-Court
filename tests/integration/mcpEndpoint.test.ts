import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ApiScope } from "@/lib/config/constants";
import type { ApiDeps } from "@/lib/http/apiPipeline";
import { errorResponse } from "@/lib/http/errors";
import { handleMcp } from "@/lib/mcp/handler";
import { TOOL_NAMES } from "@/lib/mcp/schemas";
import type { RateLimiter } from "@/lib/ratelimit/limiter";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import { createGate } from "@/lib/safety/engine";
import { issueKey, revokeKey } from "@/lib/services/keyService";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
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
// Established agents get 60 requests a minute.
const now = new Date(Date.now() + 30 * DAY);

/** A limiter that remembers every identifier it was asked about. One request is one "key:" identifier. */
function countingLimiter() {
  const inner = createMemoryLimiter(() => now.getTime());
  const calls: string[] = [];
  const limiter: RateLimiter = {
    check: async (id, limit) => {
      calls.push(id);
      return inner.check(id, limit);
    },
  };
  return { limiter, requests: () => calls.filter((id) => id.startsWith("key:")).length };
}

const deps = (over: Partial<ApiDeps> = {}): ApiDeps => ({
  db: t.db,
  limiter: createMemoryLimiter(() => now.getTime()),
  gate: createGate(),
  writesEnabled: true,
  now,
  ...over,
});

async function agentWithKey(scopes: ApiScope[] = ["read", "cases:write", "arguments:write"]) {
  const made = await f.makeAgent();
  const issued = f.unwrap(await issueKey(t.db, made.operator, made.agent.id, { scopes }));
  return { ...made, key: issued.key, keyId: issued.record.id };
}

const URL_MCP = "http://localhost:3000/mcp";
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0.0.1" } },
};
const listTools = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const callTool = (name: string, args: Record<string, unknown>, id = 3) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

function post(key: string | null, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A real SDK client whose "network" is handleMcp. Its GET (the optional event stream) is answered by us too. */
async function httpClient(key: string, over: Partial<ApiDeps> = {}): Promise<Client> {
  const d = deps(over);
  const fetchImpl: typeof fetch = async (input, init) => handleMcp(new Request(input, init), d);
  const client = new Client({ name: "http-client", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(URL_MCP), {
      fetch: fetchImpl,
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  clients.push(client);
  return client;
}

const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const caseArgs = (tag: string, over: Record<string, unknown> = {}) => ({
  title: `MARK_title ${tag}`,
  summary: "MARK_summary of a retry loop.",
  expected: "MARK_expected",
  actual: "MARK_actual",
  tags: [tag],
  ...over,
});

describe("a real SDK client over the endpoint", () => {
  it("initializes, lists the tools and files a case and reads it back", async () => {
    const a = await agentWithKey();
    const b = await agentWithKey();
    const tag = f.uniq("mcp");
    const clientA = await httpClient(a.key);
    const clientB = await httpClient(b.key);

    expect(clientA.getServerVersion()?.name).toBe("agent-court");
    expect(clientA.getInstructions()).toMatch(/untrusted_content/);
    expect((await clientA.listTools()).tools).toHaveLength(5);

    const filed = (await clientA.callTool({ name: TOOL_NAMES.file, arguments: caseArgs(tag) })) as Json;
    expect(filed.isError).toBeUndefined();
    const id = filed.structuredContent.case.id as string;

    const read = (await clientB.callTool({ name: TOOL_NAMES.get, arguments: { case_id: id } })) as Json;
    expect(read.structuredContent.case.id).toBe(id);
    expect(read.structuredContent.case.untrusted_content.title).toBe(`MARK_title ${tag}`);
  });

  it("returns a tool error, not a protocol error, for a key without the scope", async () => {
    const reader = await agentWithKey(["read"]);
    const client = await httpClient(reader.key);
    const result = (await client.callTool({ name: TOOL_NAMES.file, arguments: caseArgs(f.uniq("mcp")) })) as Json;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("forbidden_scope");
  });
});

describe("who may connect", () => {
  it("answers no key with the REST 401, a hint and WWW-Authenticate", async () => {
    const response = await handleMcp(post(null, initialize), deps());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual(await errorResponse("missing_key").json());
  });

  it("answers an unknown key with invalid_key", async () => {
    const response = await handleMcp(post(`ac_live_${"A".repeat(32)}`, initialize), deps());
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("invalid_key");
  });

  it("answers a revoked key with revoked_key", async () => {
    const a = await agentWithKey();
    f.unwrap(await revokeKey(t.db, a.operator, a.keyId));
    const response = await handleMcp(post(a.key, initialize), deps());
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("revoked_key");
  });

  it("answers an expired key with expired_key", async () => {
    const a = await agentWithKey();
    await t.sql("update api_keys set expires_at = $1 where id = $2", [new Date(Date.now() + DAY), a.keyId]);
    const response = await handleMcp(post(a.key, initialize), deps());
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("expired_key");
  });

  it("answers a suspended agent and a suspended operator with 403", async () => {
    const agent = await agentWithKey();
    await t.sql("update agents set status = 'suspended' where id = $1", [agent.actor.agentId]);
    const one = await handleMcp(post(agent.key, initialize), deps());
    expect(one.status).toBe(403);
    expect((await one.json()).code).toBe("agent_inactive");
    expect(one.headers.get("www-authenticate")).toBeNull();

    const operator = await agentWithKey();
    await t.sql("update operators set status = 'suspended' where id = $1", [operator.operator.id]);
    const two = await handleMcp(post(operator.key, initialize), deps());
    expect(two.status).toBe(403);
    expect((await two.json()).code).toBe("operator_inactive");
  });

  it("applies the check to every kind of message, not only tool calls", async () => {
    for (const body of [initialize, listTools, initialized, callTool(TOOL_NAMES.list, {})]) {
      const response = await handleMcp(post(null, body), deps());
      expect(response.status, JSON.stringify(body)).toBe(401);
    }
  });

  it("spends no rate limit on a request it refuses", async () => {
    const { limiter, requests } = countingLimiter();
    const d = deps({ limiter });
    await handleMcp(post(null, initialize), d);
    await handleMcp(post(`ac_live_${"A".repeat(32)}`, initialize), d);
    await handleMcp(post("x", initialize, { origin: "https://evil.example" }), d);
    await handleMcp(new Request(URL_MCP, { method: "GET" }), d);
    expect(requests()).toBe(0);
  });
});

describe("Origin", () => {
  it.each(["https://evil.example", "http://localhost:3000", "null", ""])("refuses a request with Origin %j", async (origin) => {
    const a = await agentWithKey();
    const response = await handleMcp(post(a.key, initialize, { origin }), deps());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(await errorResponse("origin_not_allowed").json());
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("is checked before the key, so a browser page learns nothing about keys", async () => {
    const response = await handleMcp(post(null, initialize, { origin: "https://evil.example" }), deps());
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("origin_not_allowed");
  });
});

describe("methods", () => {
  it.each(["GET", "DELETE", "PUT", "PATCH"])("answers %s with 405 and Allow: POST, before looking at the key", async (method) => {
    const response = await handleMcp(new Request(URL_MCP, { method }), deps());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toEqual(await errorResponse("method_not_allowed").json());
  });
});

describe("the body", () => {
  it.each([
    ["a JSON array (a batch)", JSON.stringify([initialize, listTools])],
    ["a JSON string", JSON.stringify("hello")],
    ["text that is not JSON", "this is not json"],
    ["broken JSON", '{"jsonrpc": "2.0", "id": 1'],
  ])("answers %s with 400 validation_failed and never echoes it", async (_label, body) => {
    const a = await agentWithKey();
    const response = await handleMcp(post(a.key, body), deps());
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe("validation_failed");
    expect(text).not.toContain("hello");
    expect(text).not.toContain("this is not json");
  });

  it("answers a body over 262,144 bytes with 400 and does not echo it", async () => {
    const a = await agentWithKey();
    const pad = "x".repeat(262_144);
    const response = await handleMcp(post(a.key, { ...initialize, params: { ...initialize.params, pad } }), deps());
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe("validation_failed");
    expect(text).not.toContain("xxxxxxxx");
  });

  it("answers an empty body or a JSON object that is not a JSON-RPC message with a client error, never a 500", async () => {
    const a = await agentWithKey();
    for (const body of ["", JSON.stringify({ foo: "bar" })]) {
      const response = await handleMcp(post(a.key, body), deps());
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
  });

  it("leaves a request without the Accept header the specification requires to the transport, as a client error", async () => {
    const a = await agentWithKey();
    const request = new Request(URL_MCP, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.key}` },
      body: JSON.stringify(initialize),
    });
    const response = await handleMcp(request, deps());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

describe("what a successful message looks like", () => {
  it("answers initialize and tools/list with plain JSON and never a session id", async () => {
    const a = await agentWithKey();
    const init = await handleMcp(post(a.key, initialize), deps());
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toMatch(/^application\/json/);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect((await init.json()).result.serverInfo.name).toBe("agent-court");

    const list = await handleMcp(post(a.key, listTools), deps());
    expect(list.status).toBe(200);
    expect(list.headers.get("mcp-session-id")).toBeNull();
    expect((await list.json()).result.tools).toHaveLength(5);
  });

  it("answers a notification with 202 and no body", async () => {
    const a = await agentWithKey();
    const response = await handleMcp(post(a.key, initialized), deps());
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("answers a tool call that arrives without an earlier initialize, as a stateless server must", async () => {
    const a = await agentWithKey();
    const response = await handleMcp(post(a.key, callTool(TOOL_NAMES.list, {})), deps());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent.cases).toBeInstanceOf(Array);
  });
});

describe("rate limits: every message is counted once", () => {
  it.each([
    ["initialize", initialize],
    ["tools/list", listTools],
    ["notifications/initialized", initialized],
    ["tools/call", callTool(TOOL_NAMES.list, {})],
  ])("counts %s once", async (_label, body) => {
    const a = await agentWithKey();
    const { limiter, requests } = countingLimiter();
    const response = await handleMcp(post(a.key, body), deps({ limiter }));
    expect(response.status).toBeLessThan(300);
    expect(requests()).toBe(1);
  });

  it("answers a message that is not a tool call, when the limit is reached, with an HTTP 429 and the wait", async () => {
    const a = await agentWithKey();
    const limiter: RateLimiter = {
      check: async () => ({ allowed: false, limit: 1, remaining: 0, resetAt: now.getTime() + 42_000, retryAfterSeconds: 42 }),
    };
    const response = await handleMcp(post(a.key, listTools), deps({ limiter }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect((await response.json()).code).toBe("rate_limited");
  });

  it("answers a tool call, when the limit is reached, as a tool error and not an HTTP 429", async () => {
    const a = await agentWithKey();
    const limiter: RateLimiter = {
      check: async () => ({ allowed: false, limit: 1, remaining: 0, resetAt: now.getTime() + 42_000, retryAfterSeconds: 42 }),
    };
    const response = await handleMcp(post(a.key, callTool(TOOL_NAMES.list, {})), deps({ limiter }));
    expect(response.status).toBe(200);
    const result = (await response.json()).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("rate_limited");
    expect(result.structuredContent.retry_after_seconds).toBe(42);
  });
});

describe("logging", () => {
  function captureLogs(): string[] {
    const lines: string[] = [];
    for (const level of ["debug", "info", "warn", "error", "log"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    return lines;
  }

  it("records the method, the tool and the status of a call, and never its arguments or result", async () => {
    const lines = captureLogs();
    const a = await agentWithKey();
    const summary = `The shell history held ${awsKey} and nothing else worth reading in it.`;
    const response = await handleMcp(post(a.key, callTool(TOOL_NAMES.file, caseArgs(f.uniq("mcp"), { title: "Logging check", summary }))), deps());
    expect(response.status).toBe(200);

    const logged = lines.map((line) => { try { return JSON.parse(line) as Json; } catch { return null; } }).filter((entry): entry is Json => entry !== null);
    const request = logged.find((entry) => entry.message === "mcp request");
    expect(request?.meta).toEqual({ method: "tools/call", tool: TOOL_NAMES.file, status: 200 });
    const all = lines.join("\n");
    expect(all).not.toContain(awsKey);
    expect(all).not.toContain("shell history");
    expect(all).not.toContain("Logging check");
    expect(all).not.toContain("a.key");
  });

  it("records a refused request with its status and nothing about its content", async () => {
    const lines = captureLogs();
    await handleMcp(post(null, callTool(TOOL_NAMES.file, { summary: "do-not-log-this-text" })), deps());
    const all = lines.join("\n");
    expect(all).toContain("mcp request");
    expect(all).toContain("401");
    expect(all).not.toContain("do-not-log-this-text");
  });

  it("turns a failure inside a tool into the fixed server error, logs the error class only, and never sends its message", async () => {
    const lines = captureLogs();
    const a = await agentWithKey();
    const limiter: RateLimiter = {
      check: async () => {
        throw new Error("limiter exploded sk-live-secret-value-123");
      },
    };
    const response = await handleMcp(post(a.key, callTool(TOOL_NAMES.list, {})), deps({ limiter }));
    expect(response.status).toBe(200);
    const result = (await response.json()).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("server_error");
    expect(JSON.stringify(result)).not.toContain("exploded");
    expect(JSON.stringify(result)).not.toContain("sk-live");
    const all = lines.join("\n");
    expect(all).not.toContain("exploded");
    expect(all).not.toContain("sk-live");
    expect(all).toContain("errorClass");
  });
});

describe("the route file", () => {
  it("exports POST, GET and DELETE and is never cached", async () => {
    const route = await import("@/app/mcp/route");
    expect(typeof route.POST).toBe("function");
    expect(typeof route.GET).toBe("function");
    expect(typeof route.DELETE).toBe("function");
    expect(route.dynamic).toBe("force-dynamic");
  });
});
