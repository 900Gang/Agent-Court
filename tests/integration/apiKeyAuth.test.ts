import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operators, type Agent, type Operator } from "@/db/schema";
import { generateApiKey } from "@/lib/auth/apiKey";
import { authenticateApiKey, hasScope } from "@/lib/auth/apiKeyAuth";
import { createAgent, setAgentStatus } from "@/lib/services/agentService";
import { issueKey, revokeKey } from "@/lib/services/keyService";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let counter = 0;
const uniq = (prefix: string) => `${prefix}-${++counter}`;
const t0 = new Date("2026-10-19T12:00:00Z");
const after = (ms: number, from = t0) => new Date(from.getTime() + ms);
const DAY = 86_400_000;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server"); // the whole file runs with the application role's privileges
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.value;
}

async function makeOperator(): Promise<Operator> {
  const [row] = await t.db
    .insert(operators)
    .values({ githubId: uniq("gh"), displayName: "Operator", status: "active" })
    .returning();
  return row;
}

async function setup(raw: Record<string, unknown> = {}, at = t0) {
  const operator = await makeOperator();
  const agent: Agent = unwrap(await createAgent(t.db, operator, { handle: uniq("agent") }));
  const issued = unwrap(await issueKey(t.db, operator, agent.id, { scopes: ["read", "cases:write"], ...raw }, at));
  return { operator, agent, key: issued.key, record: issued.record, header: `Bearer ${issued.key}` };
}

async function lastUsed(keyId: string): Promise<Date | null> {
  const [row] = await t.sql(`select last_used_at from api_keys where id = $1`, [keyId]);
  return row.last_used_at as Date | null;
}

describe("a valid key", () => {
  it("authenticates and returns exactly the agreed context", async () => {
    const { operator, agent, record, header } = await setup();
    const result = await authenticateApiKey(t.db, header, t0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.auth).toEqual({
      keyId: record.id,
      agentId: agent.id,
      operatorId: operator.id,
      scopes: ["read", "cases:write"],
      agentCreatedAt: agent.createdAt,
    });
    expect(Object.keys(result.auth).sort()).toEqual(
      ["agentCreatedAt", "agentId", "keyId", "operatorId", "scopes"].sort(),
    );
  });

  it("accepts the Bearer scheme in any case", async () => {
    const { key } = await setup();
    expect((await authenticateApiKey(t.db, `bearer ${key}`, t0)).ok).toBe(true);
    expect((await authenticateApiKey(t.db, `BEARER ${key}`, t0)).ok).toBe(true);
  });

  it("works for a key that never expires", async () => {
    const { header } = await setup({ expiresInDays: null });
    expect((await authenticateApiKey(t.db, header, after(5000 * DAY))).ok).toBe(true);
  });
});

describe("a missing or malformed header", () => {
  it.each([
    ["null", null],
    ["empty", ""],
    ["only the scheme", "Bearer"],
    ["a different scheme", "Basic abc"],
    ["two tokens", "Bearer a b"],
    ["a malformed key", "Bearer ac_live_short"],
    ["a test key", `Bearer ac_test_${"a".repeat(32)}`],
    ["the bare key with no scheme", `ac_live_${"a".repeat(32)}`],
  ])("returns missing_key for %s and does not throw", async (_label, header) => {
    expect(await authenticateApiKey(t.db, header, t0)).toEqual({ ok: false, code: "missing_key" });
  });
});

describe("keys that cannot be used", () => {
  it("returns invalid_key for a well-formed key that was never issued", async () => {
    expect(await authenticateApiKey(t.db, `Bearer ${generateApiKey().key}`, t0)).toEqual({
      ok: false,
      code: "invalid_key",
    });
  });

  it("returns revoked_key for a revoked key", async () => {
    const { operator, record, header } = await setup();
    unwrap(await revokeKey(t.db, operator, record.id, t0));
    expect(await authenticateApiKey(t.db, header, t0)).toEqual({ ok: false, code: "revoked_key" });
  });

  it("returns expired_key exactly at the expiry instant, and still accepts the key one millisecond earlier", async () => {
    const { record, header } = await setup({ expiresInDays: 30 });
    const expiresAt = record.expiresAt as Date;
    expect((await authenticateApiKey(t.db, header, after(-1, expiresAt))).ok).toBe(true);
    expect(await authenticateApiKey(t.db, header, expiresAt)).toEqual({ ok: false, code: "expired_key" });
    expect(await authenticateApiKey(t.db, header, after(1, expiresAt))).toEqual({
      ok: false,
      code: "expired_key",
    });
  });

  it("reports revoked_key rather than expired_key for a key that is both", async () => {
    const { operator, record, header } = await setup({ expiresInDays: 30 });
    unwrap(await revokeKey(t.db, operator, record.id, t0));
    expect(await authenticateApiKey(t.db, header, after(31 * DAY))).toEqual({ ok: false, code: "revoked_key" });
  });

  it("reports key problems before agent problems", async () => {
    const { operator, agent, record, header } = await setup({ expiresInDays: 30 });
    unwrap(await setAgentStatus(t.db, operator, agent.id, "suspended"));
    expect(await authenticateApiKey(t.db, header, record.expiresAt as Date)).toEqual({
      ok: false,
      code: "expired_key",
    });
  });

  it("gives a failure result with exactly two fields", async () => {
    const { operator, record, header } = await setup();
    unwrap(await revokeKey(t.db, operator, record.id, t0));
    const result = await authenticateApiKey(t.db, header, t0);
    expect(Object.keys(result).sort()).toEqual(["code", "ok"]);
  });
});

describe("agent and operator standing", () => {
  it("returns agent_inactive for a suspended agent, and access returns when it is reactivated", async () => {
    const { operator, agent, header } = await setup();
    unwrap(await setAgentStatus(t.db, operator, agent.id, "suspended"));
    expect(await authenticateApiKey(t.db, header, t0)).toEqual({ ok: false, code: "agent_inactive" });
    unwrap(await setAgentStatus(t.db, operator, agent.id, "active"));
    expect((await authenticateApiKey(t.db, header, t0)).ok).toBe(true);
  });

  it("returns agent_inactive for a deleted agent", async () => {
    const { agent, header } = await setup();
    await t.sql(`update agents set deleted_at = now() where id = $1`, [agent.id]);
    expect(await authenticateApiKey(t.db, header, t0)).toEqual({ ok: false, code: "agent_inactive" });
  });

  it.each(["suspended", "pending"])("returns operator_inactive when the operator is %s", async (status) => {
    const { operator, header } = await setup();
    await t.sql(`update operators set status = $2 where id = $1`, [operator.id, status]);
    expect(await authenticateApiKey(t.db, header, t0)).toEqual({ ok: false, code: "operator_inactive" });
  });

  it("returns operator_inactive for a deleted operator", async () => {
    const { operator, header } = await setup();
    await t.sql(`update operators set deleted_at = now() where id = $1`, [operator.id]);
    expect(await authenticateApiKey(t.db, header, t0)).toEqual({ ok: false, code: "operator_inactive" });
  });

  it("reports the agent before the operator when both are inactive", async () => {
    const { operator, agent, header } = await setup();
    unwrap(await setAgentStatus(t.db, operator, agent.id, "suspended"));
    await t.sql(`update operators set status = 'suspended' where id = $1`, [operator.id]);
    expect(await authenticateApiKey(t.db, header, t0)).toEqual({ ok: false, code: "agent_inactive" });
  });

  it("takes effect at once, with no key change", async () => {
    const { operator, header } = await setup();
    expect((await authenticateApiKey(t.db, header, t0)).ok).toBe(true);
    await t.sql(`update operators set status = 'suspended' where id = $1`, [operator.id]);
    expect(await authenticateApiKey(t.db, header, t0)).toEqual({ ok: false, code: "operator_inactive" });
  });
});

describe("last_used_at", () => {
  it("is set on the first successful request", async () => {
    const { record, header } = await setup();
    expect(await lastUsed(record.id)).toBeNull();
    await authenticateApiKey(t.db, header, t0);
    expect(await lastUsed(record.id)).toEqual(t0);
  });

  it("is not rewritten within a minute, and is rewritten from exactly one minute", async () => {
    const { record, header } = await setup();
    await authenticateApiKey(t.db, header, t0);
    await authenticateApiKey(t.db, header, after(30_000));
    expect(await lastUsed(record.id)).toEqual(t0);
    await authenticateApiKey(t.db, header, after(59_999));
    expect(await lastUsed(record.id)).toEqual(t0);
    await authenticateApiKey(t.db, header, after(60_000));
    expect(await lastUsed(record.id)).toEqual(after(60_000));
  });

  it("is never written by a failed request", async () => {
    const { operator, agent, record, header } = await setup();
    unwrap(await setAgentStatus(t.db, operator, agent.id, "suspended"));
    await authenticateApiKey(t.db, header, t0);
    unwrap(await setAgentStatus(t.db, operator, agent.id, "active"));
    unwrap(await revokeKey(t.db, operator, record.id, t0));
    await authenticateApiKey(t.db, header, t0);
    await authenticateApiKey(t.db, "Bearer nonsense", t0);
    expect(await lastUsed(record.id)).toBeNull();
  });
});

describe("hasScope", () => {
  it("is true only for scopes the key holds", async () => {
    const { header } = await setup({ scopes: ["read", "cases:write"] });
    const result = await authenticateApiKey(t.db, header, t0);
    if (!result.ok) throw new Error("expected ok");
    expect(hasScope(result.auth, "read")).toBe(true);
    expect(hasScope(result.auth, "cases:write")).toBe(true);
    expect(hasScope(result.auth, "arguments:write")).toBe(false);
  });
});
