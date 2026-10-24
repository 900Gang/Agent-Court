import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiScope } from "@/lib/config/constants";
import {
  jsonResponse,
  readJsonBody,
  runApi,
  validationFailed,
  type ApiContext,
  type ApiDeps,
} from "@/lib/http/apiPipeline";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import { fileCase } from "@/lib/services/caseService";
import { issueKey, revokeKey } from "@/lib/services/keyService";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;

const DAY = 86_400_000;
// The agent is created at the real time; asking 30 days later makes it an established agent (60 per minute).
const now = new Date(Date.now() + 30 * DAY);

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

async function setup(scopes: ApiScope[] = ["read", "cases:write", "arguments:write"]) {
  const made = await f.makeAgent();
  const issued = f.unwrap(await issueKey(t.db, made.operator, made.agent.id, { scopes }));
  return { ...made, key: issued.key, keyId: issued.record.id };
}

const deps = (over: Partial<ApiDeps> = {}): ApiDeps => ({
  db: t.db,
  limiter: createMemoryLimiter(() => now.getTime()),
  gate: passGate,
  writesEnabled: true,
  now,
  ...over,
});

function recorder(status = 201) {
  const seen: ApiContext[] = [];
  const handler = async (ctx: ApiContext) => {
    seen.push(ctx);
    return jsonResponse(status, { ok: true });
  };
  return { seen, handler };
}

const write = { scope: "cases:write", write: true } as const;
const read = { scope: "read", write: false } as const;

function post(key: string | null, init: { body?: string; headers?: Record<string, string>; path?: string } = {}) {
  return new Request(`http://localhost:3000${init.path ?? "/api/v1/cases"}`, {
    method: "POST",
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json", ...init.headers },
    body: init.body,
  });
}

function get(key: string | null, path = "/api/v1/cases") {
  return new Request(`http://localhost:3000${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
}

describe("runApi: write flag", () => {
  it("refuses a write with 503 writes_disabled before it even looks at the key", async () => {
    const { handler, seen } = recorder();
    const response = await runApi(post(null, { body: "{}" }), deps({ writesEnabled: false }), write, handler);
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("writes_disabled");
    expect(seen).toHaveLength(0);
  });

  it("still serves reads when writes are off", async () => {
    const { key } = await setup();
    const { handler, seen } = recorder(200);
    const response = await runApi(get(key), deps({ writesEnabled: false }), read, handler);
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
  });
});

describe("runApi: authentication, scope and rate limit", () => {
  it("answers 401 for a missing, unknown or revoked key", async () => {
    const { handler, seen } = recorder();
    const missing = await runApi(get(null), deps(), read, handler);
    expect(missing.status).toBe(401);
    expect((await missing.json()).code).toBe("missing_key");
    const unknown = await runApi(get(`ac_live_${"x".repeat(32)}`), deps(), read, handler);
    expect((await unknown.json()).code).toBe("invalid_key");

    const { operator, key, keyId } = await setup();
    f.unwrap(await revokeKey(t.db, operator, keyId));
    const revoked = await runApi(get(key), deps(), read, handler);
    expect((await revoked.json()).code).toBe("revoked_key");
    expect(seen).toHaveLength(0);
  });

  it("answers 403 forbidden_scope and spends no rate-limit slot", async () => {
    const { key } = await setup(["read"]);
    const shared = deps();
    const { handler, seen } = recorder();
    const denied = await runApi(post(key, { body: "{}" }), shared, write, handler);
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("forbidden_scope");
    expect(seen).toHaveLength(0);

    const allowed = await runApi(get(key), shared, read, recorder(200).handler);
    expect(allowed.headers.get("ratelimit-remaining")).toBe("59");
  });

  it("sends rate-limit headers on success and on errors the handler returns", async () => {
    const { key } = await setup();
    const ok = await runApi(get(key), deps(), read, recorder(200).handler);
    expect(ok.headers.get("ratelimit-limit")).toBe("60");
    expect(ok.headers.get("ratelimit-remaining")).toBe("59");

    const conflict = await runApi(post(key, { body: "{}" }), deps(), write, async () => jsonResponse(409, { code: "conflict" }));
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("ratelimit-remaining")).not.toBeNull();
  });

  it("answers 429 with Retry-After after 60 requests in a minute, and checks it before the body", async () => {
    const { key } = await setup();
    const shared = deps();
    const { handler } = recorder(200);
    for (let i = 0; i < 60; i++) expect((await runApi(get(key), shared, read, handler)).status).toBe(200);
    const limited = await runApi(post(key, { body: "{not json" }), shared, write, handler);
    expect(limited.status).toBe(429);
    expect((await limited.json()).code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("runApi: request body", () => {
  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"x"'],
    ["a number", "5"],
    ["broken JSON", "{bad"],
    ["a body over 262,144 bytes", `{"a":"${"a".repeat(262_141)}"}`],
  ])("answers 400 validation_failed for %s and never calls the handler", async (_label, body) => {
    const { key } = await setup();
    const { handler, seen } = recorder();
    const response = await runApi(post(key, { body }), deps(), write, handler);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("validation_failed");
    expect(seen).toHaveLength(0);
  });

  it("accepts a body of exactly 262,144 bytes", async () => {
    const { key } = await setup();
    const body = `{"a":"${"a".repeat(262_144 - 8)}"}`;
    expect(new TextEncoder().encode(body).byteLength).toBe(262_144);
    const { handler, seen } = recorder();
    expect((await runApi(post(key, { body }), deps(), write, handler)).status).toBe(201);
    expect(seen).toHaveLength(1);
  });

  it("gives the handler {} for an empty body and the parsed object otherwise", async () => {
    const { key } = await setup();
    const empty = recorder();
    await runApi(post(key), deps(), write, empty.handler);
    expect(empty.seen[0].body).toEqual({});

    const filled = recorder();
    await runApi(post(key, { body: '{"title":"x"}' }), deps(), write, filled.handler);
    expect(filled.seen[0].body).toEqual({ title: "x" });
  });

  it("hands reads the query string and does not parse a body", async () => {
    const { key, agent } = await setup();
    const { handler, seen } = recorder(200);
    await runApi(get(key, "/api/v1/cases?limit=5&tag=a"), deps(), read, handler);
    expect(seen[0].searchParams.get("limit")).toBe("5");
    expect(seen[0].searchParams.get("tag")).toBe("a");
    expect(seen[0].auth.agentId).toBe(agent.id);
    expect(seen[0].now).toEqual(now);
  });
});

describe("runApi: Idempotency-Key", () => {
  it("answers 400 with the header name when the key is malformed", async () => {
    const { key } = await setup();
    const { handler, seen } = recorder();
    const response = await runApi(post(key, { body: "{}", headers: { "idempotency-key": "short" } }), deps(), write, handler);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("validation_failed");
    expect(body.fields).toContain("Idempotency-Key");
    expect(seen).toHaveLength(0);
  });

  it("runs the handler once for a retried request and marks the replay", async () => {
    const { key } = await setup();
    const shared = deps();
    const { handler, seen } = recorder();
    const headers = { "idempotency-key": "pipeline-key-01" };
    const first = await runApi(post(key, { body: '{"a":1}', headers }), shared, write, handler);
    const second = await runApi(post(key, { body: '{"a":1}', headers }), shared, write, handler);
    expect(seen).toHaveLength(1);
    expect(first.headers.get("idempotent-replay")).toBeNull();
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replay")).toBe("true");
    expect(second.headers.get("ratelimit-remaining")).toBe("58");
    expect(await second.text()).toBe(await first.text());
  });

  it("refuses the same key with a different body or a different path", async () => {
    const { key } = await setup();
    const shared = deps();
    const { handler } = recorder();
    const headers = { "idempotency-key": "pipeline-key-02" };
    await runApi(post(key, { body: '{"a":1}', headers }), shared, write, handler);
    const otherBody = await runApi(post(key, { body: '{"a":2}', headers }), shared, write, handler);
    expect(otherBody.status).toBe(422);
    expect((await otherBody.json()).code).toBe("idempotency_conflict");
    const otherPath = await runApi(post(key, { body: '{"a":1}', headers, path: "/api/v1/other" }), shared, write, handler);
    expect(otherPath.status).toBe(422);
  });

  it("does not keep a claim when the handler answers with an error", async () => {
    const { key } = await setup();
    const shared = deps();
    const headers = { "idempotency-key": "pipeline-key-03" };
    const failing = await runApi(post(key, { body: "{}", headers }), shared, write, async () => jsonResponse(409, { code: "conflict" }));
    expect(failing.status).toBe(409);
    const { handler, seen } = recorder();
    const retry = await runApi(post(key, { body: "{}", headers }), shared, write, handler);
    expect(retry.status).toBe(201);
    expect(seen).toHaveLength(1);
  });

  it("hands the handler a transaction, so a write and the claim commit together", async () => {
    const { key, actor } = await setup();
    const headers = { "idempotency-key": "pipeline-key-04" };
    const writeThenFail = async (ctx: ApiContext) => {
      f.unwrap(await fileCase(ctx.db, passGate, actor, { title: "T", summary: "S", expected: "E", actual: "A" }));
      return jsonResponse(500, { code: "oops" });
    };
    await runApi(post(key, { body: "{}", headers }), deps(), write, writeThenFail);
    expect(await f.count("cases where agent_id = $1", [actor.agentId])).toBe(0);
  });
});

describe("readJsonBody", () => {
  const req = (body: string | null) => new Request("http://localhost/x", { method: "POST", body });

  it("returns {} for an empty body and the object for a JSON object", async () => {
    expect(await readJsonBody(req(null))).toEqual({ ok: true, value: {} });
    expect(await readJsonBody(req(""))).toEqual({ ok: true, value: {} });
    expect(await readJsonBody(req('{"a":[1,2]}'))).toEqual({ ok: true, value: { a: [1, 2] } });
  });

  it.each(["null", "[]", '"x"', "5", "true", "{bad", "{"])("rejects %s", async (body) => {
    expect((await readJsonBody(req(body))).ok).toBe(false);
  });

  it("does not throw when the body stream fails", async () => {
    const stream = new ReadableStream({ start: (controller) => controller.error(new Error("connection reset")) });
    const request = new Request("http://localhost/x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    const result = await readJsonBody(request);
    expect(result.ok).toBe(false);
  });

  it("rejects a body over the size limit without parsing it", async () => {
    const big = `{"a":"${"a".repeat(262_200)}"}`;
    expect((await readJsonBody(req(big))).ok).toBe(false);
  });
});

describe("jsonResponse and validationFailed", () => {
  it("builds a JSON response that is never cached", async () => {
    const response = jsonResponse(201, { a: 1 }, { "X-Test": "yes" });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-test")).toBe("yes");
    expect(await response.json()).toEqual({ a: 1 });
  });

  it("does not let extra headers replace the content type or caching rules", () => {
    const response = jsonResponse(200, {}, { "Content-Type": "text/html", "Cache-Control": "public" });
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("lists field names only", async () => {
    const response = validationFailed({ title: "must not be empty", tags: "at most 8 tags" });
    expect(response.status).toBe(400);
    expect((await response.json()).fields).toEqual(["title", "tags"]);
    expect(Object.keys(await validationFailed().json())).toEqual(["code", "message", "hint"]);
  });
});
