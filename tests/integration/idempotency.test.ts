import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/types";
import { hashRequest, runIdempotent } from "@/lib/http/idempotency";
import { fileCase } from "@/lib/services/caseService";
import { recordModeration } from "@/lib/services/moderationService";
import { passGate } from "../helpers/gates";
import { createFixtures, type TestActor } from "../helpers/fixtures";
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

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const body = {
  title: "Tool call loops",
  summary: "The agent repeats a call.",
  expected: "One call.",
  actual: "Ten calls.",
};
const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

/** A unit of work that files a case and answers with a response, counting how often it ran. */
function makeWork(actor: TestActor, status = 201) {
  const state = { calls: 0 };
  const work = async (tx: Database) => {
    state.calls++;
    const filed = f.unwrap(await fileCase(tx, passGate, actor, body));
    return new Response(JSON.stringify({ id: filed.case.id }), { status, headers: jsonHeaders });
  };
  return { work, state };
}

const input = (agentId: string, key: string | null, requestHash = "hash-a", now = new Date()) => ({
  agentId,
  key,
  requestHash,
  now,
});

const caseCount = (agentId: string) => f.count("cases where agent_id = $1", [agentId]);

describe("runIdempotent: retries", () => {
  it("creates one row and replays the same response for the same key", async () => {
    const { actor } = await f.makeAgent();
    const { work, state } = makeWork(actor);
    const key = "retry-key-0001";

    const first = await runIdempotent(t.db, input(actor.agentId, key), work);
    const second = await runIdempotent(t.db, input(actor.agentId, key), work);

    expect(state.calls).toBe(1);
    expect(await caseCount(actor.agentId)).toBe(1);
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replay")).toBeNull();
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replay")).toBe("true");
    expect(second.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await second.text()).toBe(await first.text());
  });

  it("lets the caller read the first response body", async () => {
    const { actor } = await f.makeAgent();
    const { work } = makeWork(actor);
    const first = await runIdempotent(t.db, input(actor.agentId, "readable-key-1"), work);
    expect(await first.json()).toEqual({ id: expect.any(String) });
  });

  it("replays a 202 as a 202", async () => {
    const { actor } = await f.makeAgent();
    const { work } = makeWork(actor, 202);
    await runIdempotent(t.db, input(actor.agentId, "held-key-00001"), work);
    expect((await runIdempotent(t.db, input(actor.agentId, "held-key-00001"), work)).status).toBe(202);
  });

  it("refuses the same key with a different request", async () => {
    const { actor } = await f.makeAgent();
    const { work, state } = makeWork(actor);
    await runIdempotent(t.db, input(actor.agentId, "conflict-key-1", "hash-a"), work);
    const conflict = await runIdempotent(t.db, input(actor.agentId, "conflict-key-1", "hash-b"), work);
    expect(conflict.status).toBe(422);
    expect((await conflict.json()).code).toBe("idempotency_conflict");
    expect(state.calls).toBe(1);
    expect(await caseCount(actor.agentId)).toBe(1);
  });

  it("keeps keys separate for each agent", async () => {
    const one = await f.makeAgent();
    const two = await f.makeAgent();
    const a = makeWork(one.actor);
    const b = makeWork(two.actor);
    const first = await runIdempotent(t.db, input(one.actor.agentId, "shared-key-001"), a.work);
    const second = await runIdempotent(t.db, input(two.actor.agentId, "shared-key-001"), b.work);
    expect(first.headers.get("idempotent-replay")).toBeNull();
    expect(second.headers.get("idempotent-replay")).toBeNull();
    expect(await caseCount(one.actor.agentId)).toBe(1);
    expect(await caseCount(two.actor.agentId)).toBe(1);
  });

  it("runs the work every time when there is no key", async () => {
    const { actor } = await f.makeAgent();
    const { work, state } = makeWork(actor);
    await runIdempotent(t.db, input(actor.agentId, null), work);
    await runIdempotent(t.db, input(actor.agentId, null), work);
    expect(state.calls).toBe(2);
    expect(await caseCount(actor.agentId)).toBe(2);
    expect(await f.count("idempotency_keys where agent_id = $1", [actor.agentId])).toBe(0);
  });

  it("handles two simultaneous requests with the same key", async () => {
    const { actor } = await f.makeAgent();
    const { work, state } = makeWork(actor);
    const [one, two] = await Promise.all([
      runIdempotent(t.db, input(actor.agentId, "parallel-key-01"), work),
      runIdempotent(t.db, input(actor.agentId, "parallel-key-01"), work),
    ]);
    expect(state.calls).toBe(1);
    expect(await caseCount(actor.agentId)).toBe(1);
    expect(await one.text()).toBe(await two.text());
    expect([one, two].filter((r) => r.headers.get("idempotent-replay") === "true")).toHaveLength(1);
  });
});

describe("runIdempotent: failures leave nothing behind", () => {
  it("keeps no claim after a non-2xx response, so the key can be reused", async () => {
    const { actor } = await f.makeAgent();
    const failing = async () => new Response(JSON.stringify({ code: "blocked" }), { status: 422, headers: jsonHeaders });
    const response = await runIdempotent(t.db, input(actor.agentId, "failed-key-001", "hash-a"), failing);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ code: "blocked" });
    expect(await f.count("idempotency_keys where agent_id = $1", [actor.agentId])).toBe(0);

    const { work, state } = makeWork(actor);
    const retry = await runIdempotent(t.db, input(actor.agentId, "failed-key-001", "hash-b"), work);
    expect(retry.status).toBe(201);
    expect(state.calls).toBe(1);
  });

  it.each([["a key", "refusal-key-001"], ["no key", null]])("keeps a moderation event written before a non-2xx response, with %s", async (_label, key) => {
    const { actor } = await f.makeAgent();
    const before = await f.count("moderation_events where target_type = 'case' and target_id is null and result = 'block'");
    const blockThenRefuse = async (tx: Database) => {
      await recordModeration(tx, { targetType: "case", targetId: null, check: "injection", result: "block" });
      return new Response("{}", { status: 422, headers: jsonHeaders });
    };
    const response = await runIdempotent(t.db, input(actor.agentId, key), blockThenRefuse);
    expect(response.status).toBe(422);
    expect(await f.count("moderation_events where target_type = 'case' and target_id is null and result = 'block'")).toBe(before + 1);
    expect(await f.count("idempotency_keys where agent_id = $1", [actor.agentId])).toBe(0);
  });

  it.each([["a key", "throw-key-00001"], ["no key", null]])("rolls back and rethrows when the work throws with %s", async (_label, key) => {
    const { actor } = await f.makeAgent();
    const writeThenThrow = async (tx: Database) => {
      f.unwrap(await fileCase(tx, passGate, actor, body));
      throw new Error("boom");
    };
    await expect(runIdempotent(t.db, input(actor.agentId, key), writeThenThrow)).rejects.toThrow("boom");
    expect(await caseCount(actor.agentId)).toBe(0);
    expect(await f.count("idempotency_keys where agent_id = $1", [actor.agentId])).toBe(0);
  });
});

describe("runIdempotent: storage", () => {
  it("stores a hash of the key, the request hash and the response, never the raw key", async () => {
    const { actor } = await f.makeAgent();
    const { work } = makeWork(actor);
    const key = "storage-key-0001";
    const response = await runIdempotent(t.db, input(actor.agentId, key, "hash-stored"), work);
    const [row] = await t.sql(`select key_hash, request_hash, response_ref from idempotency_keys where agent_id = $1`, [actor.agentId]);
    expect(row.key_hash).toBe(sha256(key));
    expect(row.request_hash).toBe("hash-stored");
    expect(JSON.stringify(row)).not.toContain(key);
    const ref = JSON.parse(row.response_ref as string);
    expect(Object.keys(ref).sort()).toEqual(["body", "status"]);
    expect(ref.status).toBe(201);
    expect(ref.body).toBe(await response.text());
  });

  it("replays a stored response exactly as stored", async () => {
    const { actor } = await f.makeAgent();
    const key = "stored-replay-01";
    await t.sql(
      `insert into idempotency_keys (key_hash, agent_id, request_hash, response_ref) values ($1, $2, 'hash-a', $3)`,
      [sha256(key), actor.agentId, JSON.stringify({ status: 201, body: '{"id":"stored"}' })],
    );
    const { work, state } = makeWork(actor);
    const response = await runIdempotent(t.db, input(actor.agentId, key, "hash-a"), work);
    expect(state.calls).toBe(0);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"id":"stored"}');
  });

  it("ignores and replaces a claim older than 24 hours", async () => {
    const { actor } = await f.makeAgent();
    const key = "expired-key-001";
    const now = new Date();
    await t.sql(
      `insert into idempotency_keys (key_hash, agent_id, request_hash, response_ref, created_at) values ($1, $2, 'old-hash', $3, $4)`,
      [sha256(key), actor.agentId, JSON.stringify({ status: 201, body: '{"id":"old"}' }), new Date(now.getTime() - 25 * 3600_000).toISOString()],
    );
    const { work, state } = makeWork(actor);
    const response = await runIdempotent(t.db, input(actor.agentId, key, "new-hash", now), work);
    expect(state.calls).toBe(1);
    expect(response.headers.get("idempotent-replay")).toBeNull();
    const [row] = await t.sql(`select request_hash from idempotency_keys where agent_id = $1`, [actor.agentId]);
    expect(row.request_hash).toBe("new-hash");
  });

  it("still replays a claim that is 23 hours old", async () => {
    const { actor } = await f.makeAgent();
    const key = "recent-key-0001";
    const now = new Date();
    await t.sql(
      `insert into idempotency_keys (key_hash, agent_id, request_hash, response_ref, created_at) values ($1, $2, 'hash-a', $3, $4)`,
      [sha256(key), actor.agentId, JSON.stringify({ status: 201, body: '{"id":"kept"}' }), new Date(now.getTime() - 23 * 3600_000).toISOString()],
    );
    const { work, state } = makeWork(actor);
    const response = await runIdempotent(t.db, input(actor.agentId, key, "hash-a", now), work);
    expect(state.calls).toBe(0);
    expect(await response.text()).toBe('{"id":"kept"}');
  });
});

describe("hashRequest", () => {
  it("is a 64 character hex digest", () => {
    expect(hashRequest("POST", "/api/v1/cases", { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on the order of object keys, at any depth", () => {
    expect(hashRequest("POST", "/p", { a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } })).toBe(
      hashRequest("POST", "/p", { b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 }),
    );
  });

  it("changes with the method, the path or the body", () => {
    const base = hashRequest("POST", "/p", { a: 1 });
    expect(hashRequest("PUT", "/p", { a: 1 })).not.toBe(base);
    expect(hashRequest("POST", "/q", { a: 1 })).not.toBe(base);
    expect(hashRequest("POST", "/p", { a: 2 })).not.toBe(base);
    expect(hashRequest("POST", "/p", { a: [1, 2] })).not.toBe(hashRequest("POST", "/p", { a: [2, 1] }));
  });

  it("tells an empty body from a body with a key", () => {
    expect(hashRequest("POST", "/p", {})).not.toBe(hashRequest("POST", "/p", { a: null }));
  });
});
