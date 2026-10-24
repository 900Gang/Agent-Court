import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiScope } from "@/lib/config/constants";
import type { ApiDeps } from "@/lib/http/apiPipeline";
import {
  handleAddEvidence,
  handleFileCase,
  handleGetCase,
  handleListCases,
  handleWithdrawCase,
} from "@/lib/http/handlers/cases";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import { failClosedGate } from "@/lib/safety/stub";
import type { SafetyGate } from "@/lib/safety/gate";
import { issueKey } from "@/lib/services/keyService";
import { blockGate, passGate } from "../helpers/gates";
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

const validCase = (tag: string) => ({
  title: "MARK_title",
  summary: "MARK_summary",
  expected: "MARK_expected",
  actual: "MARK_actual",
  tags: [tag],
  environment: { model: "model-a", notes: "MARK_notes" },
  evidence: [{ kind: "trace", text: "MARK_evidence" }],
});

function req(method: string, path: string, key: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function fileAs(a: { key: string }, d: ApiDeps, tag: string, headers: Record<string, string> = {}) {
  const response = await handleFileCase(req("POST", "/api/v1/cases", a.key, validCase(tag), headers), d);
  return { response, body: (await response.clone().json()) as Json };
}

function leaves(value: unknown, path: string[] = []): Array<{ path: string[]; value: unknown }> {
  if (Array.isArray(value)) return value.flatMap((item, i) => leaves(item, [...path, String(i)]));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
  }
  return [{ path, value }];
}

function expectEnvelope(body: unknown) {
  const marked = leaves(body).filter((leaf) => typeof leaf.value === "string" && /MARK|mark-tag/.test(leaf.value as string));
  expect(marked.length).toBeGreaterThan(0);
  for (const leaf of marked) expect(leaf.path, `${leaf.path.join(".")} outside untrusted_content`).toContain("untrusted_content");
  expect((body as Json).notice).toMatch(/untrusted_content/);
}

describe("case routes: the full walk with a passing gate", () => {
  it("files, lists, reads, adds evidence to and withdraws a case", async () => {
    const a = await agentWithKey();
    const b = await agentWithKey(["read"]);
    const d = deps();

    const filed = await fileAs(a, d, "walk-one");
    expect(filed.response.status).toBe(201);
    expect(filed.response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(filed.response.headers.get("cache-control")).toBe("no-store");
    expect(filed.body.case.status).toBe("open");
    expect(filed.body.case.filed_by).toEqual({ handle: a.agent.handle });
    expect(filed.body.case.evidence).toHaveLength(1);
    expectEnvelope(filed.body);
    const id = filed.body.case.id as string;

    const listed = await handleListCases(req("GET", "/api/v1/cases?tag=walk-one&needs_arguments=true", b.key), d);
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as Json;
    expect(listBody.cases.map((c: Json) => c.id)).toEqual([id]);
    expect(listBody.next_cursor).toBeNull();
    expectEnvelope(listBody);

    const read = await handleGetCase(req("GET", `/api/v1/cases/${id}`, b.key), d, { id });
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as Json;
    expect(readBody.case.evidence).toHaveLength(1);
    expect(readBody.case.verdict).toBeNull();
    expectEnvelope(readBody);

    const added = await handleAddEvidence(req("POST", `/api/v1/cases/${id}/evidence`, a.key, { kind: "error", text: "MARK_boom" }), d, { id });
    expect(added.status).toBe(201);
    const addedBody = (await added.json()) as Json;
    expect(addedBody.evidence.status).toBe("active");
    expectEnvelope(addedBody);

    const withdrawn = await handleWithdrawCase(req("POST", `/api/v1/cases/${id}/withdraw`, a.key, {}), d, { id });
    expect(withdrawn.status).toBe(200);
    const withdrawnBody = (await withdrawn.json()) as Json;
    expect(withdrawnBody.case.status).toBe("withdrawn");
    expectEnvelope(withdrawnBody);

    const gone = await handleGetCase(req("GET", `/api/v1/cases/${id}`, b.key), d, { id });
    expect(gone.status).toBe(404);
    const after = await handleListCases(req("GET", "/api/v1/cases?tag=walk-one", b.key), d);
    expect(((await after.json()) as Json).cases).toEqual([]);
  });
});

describe("case routes: the production stub holds everything", () => {
  it("answers 202 held_for_review and hides the case from everyone else", async () => {
    const a = await agentWithKey();
    const b = await agentWithKey(["read"]);
    const d = deps(failClosedGate);

    const filed = await fileAs(a, d, "held-one");
    expect(filed.response.status).toBe(202);
    expect(filed.body.code).toBe("held_for_review");
    expect(filed.body.hint).toMatch(/not public/i);
    expect(filed.body.case.status).toBe("held");
    expect(filed.body.case.evidence[0].status).toBe("held");
    const id = filed.body.case.id as string;

    const other = await handleGetCase(req("GET", `/api/v1/cases/${id}`, b.key), d, { id });
    expect(other.status).toBe(404);
    expect(((await other.json()) as Json).code).toBe("not_found");
    const own = await handleGetCase(req("GET", `/api/v1/cases/${id}`, a.key), d, { id });
    expect(own.status).toBe(200);
    expect(((await own.json()) as Json).case.status).toBe("held");

    for (const key of [a.key, b.key]) {
      const list = await handleListCases(req("GET", "/api/v1/cases?tag=held-one", key), d);
      expect(((await list.json()) as Json).cases).toEqual([]);
    }
  });

  it("answers 202 for evidence the gate flags", async () => {
    const a = await agentWithKey();
    const d = deps(failClosedGate);
    const filed = await fileAs(a, d, "held-two");
    const id = filed.body.case.id as string;
    const added = await handleAddEvidence(req("POST", `/api/v1/cases/${id}/evidence`, a.key, { kind: "trace", text: "x" }), d, { id });
    expect(added.status).toBe(202);
    const body = (await added.json()) as Json;
    expect(body.code).toBe("held_for_review");
    expect(body.evidence.status).toBe("held");
  });

  it("answers 422 blocked and stores nothing when the gate blocks", async () => {
    const a = await agentWithKey();
    const filed = await fileAs(a, deps(blockGate), "blocked-one");
    expect(filed.response.status).toBe(422);
    expect(filed.body.code).toBe("blocked");
    expect(Object.keys(filed.body)).toEqual(["code", "message", "hint"]);
    expect(await f.count("cases where agent_id = $1", [a.agent.id])).toBe(0);
  });
});

describe("case routes: errors", () => {
  it("answers 404 for ids that are not UUIDs and for unknown cases", async () => {
    const a = await agentWithKey();
    const d = deps();
    for (const id of ["not-a-uuid", "%00", crypto.randomUUID()]) {
      expect((await handleGetCase(req("GET", `/api/v1/cases/${id}`, a.key), d, { id })).status).toBe(404);
      expect((await handleAddEvidence(req("POST", `/api/v1/cases/${id}/evidence`, a.key, { kind: "trace", text: "x" }), d, { id })).status).toBe(404);
      expect((await handleWithdrawCase(req("POST", `/api/v1/cases/${id}/withdraw`, a.key, {}), d, { id })).status).toBe(404);
    }
  });

  it.each([
    ["limit=0", "limit"],
    ["limit=1000", "limit"],
    ["limit=abc", "limit"],
    ["cursor=!!", "cursor"],
    ["status=held", "status"],
    ["tag=Bad%20Tag", "tag"],
    ["needs_arguments=yes", "needs_arguments"],
  ])("answers 400 for ?%s and names the field", async (query, field) => {
    const a = await agentWithKey();
    const response = await handleListCases(req("GET", `/api/v1/cases?${query}`, a.key), deps());
    expect(response.status).toBe(400);
    const body = (await response.json()) as Json;
    expect(body.code).toBe("validation_failed");
    expect(body.fields).toContain(field);
  });

  it("answers 400 for an unknown field and keeps the submitted value out of the response", async () => {
    const a = await agentWithKey();
    const response = await handleFileCase(req("POST", "/api/v1/cases", a.key, { ...validCase("x-one"), agent_id: "SECRET_VALUE_1" }), deps());
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text).fields).toContain("form");
    expect(text).not.toContain("SECRET_VALUE_1");
    expect(text).not.toContain("agent_id");
  });

  it("answers 403 to a key without the scope", async () => {
    const readOnly = await agentWithKey(["read"]);
    const response = await handleFileCase(req("POST", "/api/v1/cases", readOnly.key, validCase("scope-one")), deps());
    expect(response.status).toBe(403);
    expect(((await response.json()) as Json).code).toBe("forbidden_scope");
    const writeOnly = await agentWithKey(["cases:write"]);
    expect((await handleListCases(req("GET", "/api/v1/cases", writeOnly.key), deps())).status).toBe(403);
  });

  it("answers 404 to another agent's evidence and withdraw requests, and 409 to a repeated withdraw", async () => {
    const a = await agentWithKey();
    const b = await agentWithKey();
    const d = deps();
    const id = (await fileAs(a, d, "other-one")).body.case.id as string;
    expect((await handleAddEvidence(req("POST", `/api/v1/cases/${id}/evidence`, b.key, { kind: "trace", text: "x" }), d, { id })).status).toBe(404);
    expect((await handleWithdrawCase(req("POST", `/api/v1/cases/${id}/withdraw`, b.key, {}), d, { id })).status).toBe(404);
    expect((await handleWithdrawCase(req("POST", `/api/v1/cases/${id}/withdraw`, a.key, {}), d, { id })).status).toBe(200);
    const again = await handleWithdrawCase(req("POST", `/api/v1/cases/${id}/withdraw`, a.key, {}), d, { id });
    expect(again.status).toBe(409);
    expect(((await again.json()) as Json).code).toBe("illegal_transition");
  });

  it("answers 409 conflict when a case already has ten evidence items", async () => {
    const a = await agentWithKey();
    const c = await f.insertCase(a.agent.id, { status: "open" });
    for (let i = 0; i < 10; i++) await f.insertEvidence(c.id, "active");
    const response = await handleAddEvidence(req("POST", `/api/v1/cases/${c.id}/evidence`, a.key, { kind: "trace", text: "x" }), deps(), { id: c.id });
    expect(response.status).toBe(409);
    expect(((await response.json()) as Json).code).toBe("conflict");
  });

  it("refuses writes with 503 when the flag is off, but still lists", async () => {
    const a = await agentWithKey();
    const d = deps(passGate, { writesEnabled: false });
    const filed = await handleFileCase(req("POST", "/api/v1/cases", a.key, validCase("flag-one")), d);
    expect(filed.status).toBe(503);
    expect(((await filed.json()) as Json).code).toBe("writes_disabled");
    expect((await handleListCases(req("GET", "/api/v1/cases", a.key), d)).status).toBe(200);
  });
});

describe("case routes: pagination and retries", () => {
  it("pages through five cases two at a time using next_cursor", async () => {
    const a = await agentWithKey();
    const b = await agentWithKey(["read"]);
    const base = Date.parse("2026-10-20T12:00:00Z");
    for (let i = 0; i < 5; i++) await f.insertCase(a.agent.id, { status: "open", tags: ["page-one"], createdAt: new Date(base - i * 60_000) });
    const d = deps();
    const ids: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const suffix: string = cursor ? `&cursor=${cursor}` : "";
      const response = await handleListCases(req("GET", `/api/v1/cases?tag=page-one&limit=2${suffix}`, b.key), d);
      const body = (await response.json()) as Json;
      sizes.push(body.cases.length);
      ids.push(...body.cases.map((c: Json) => c.id));
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    expect(sizes).toEqual([2, 2, 1]);
    expect(new Set(ids).size).toBe(5);
  });

  it("creates one case and replays the held status for a retried POST", async () => {
    const a = await agentWithKey();
    const d = deps(failClosedGate);
    const headers = { "idempotency-key": "route-retry-0001" };
    const first = await fileAs(a, d, "retry-one", headers);
    const second = await fileAs(a, d, "retry-one", headers);
    expect(first.response.status).toBe(202);
    expect(second.response.status).toBe(202);
    expect(second.response.headers.get("idempotent-replay")).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(await f.count("cases where agent_id = $1", [a.agent.id])).toBe(1);
  });
});

describe("case routes: nothing internal leaks", () => {
  it("never returns key material or internal ids", async () => {
    const a = await agentWithKey();
    const b = await agentWithKey(["read"]);
    const d = deps();
    const filed = await fileAs(a, d, "leak-one");
    const id = filed.body.case.id as string;
    const texts = [
      JSON.stringify(filed.body),
      await (await handleListCases(req("GET", "/api/v1/cases?tag=leak-one", b.key), d)).text(),
      await (await handleGetCase(req("GET", `/api/v1/cases/${id}`, b.key), d, { id })).text(),
    ].join("\n");
    for (const forbidden of ["key_hash", "operator_id", "agent_id", "redaction_report", a.key, b.key, a.operator.id]) {
      expect(texts).not.toContain(forbidden);
    }
  });
});

describe("case route files", () => {
  it.each([
    ["@/app/api/v1/cases/route", ["GET", "POST"]],
    ["@/app/api/v1/cases/[id]/route", ["GET"]],
    ["@/app/api/v1/cases/[id]/evidence/route", ["POST"]],
    ["@/app/api/v1/cases/[id]/withdraw/route", ["POST"]],
  ])("%s exports %j and is never cached", async (path, methods) => {
    const route = await import(/* @vite-ignore */ path);
    for (const method of methods) expect(typeof route[method]).toBe("function");
    expect(route.dynamic).toBe("force-dynamic");
  });
});
