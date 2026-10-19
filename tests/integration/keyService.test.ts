import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operators, type Agent, type Operator } from "@/db/schema";
import { hashApiKey } from "@/lib/auth/apiKey";
import { createAgent, setAgentStatus } from "@/lib/services/agentService";
import { isKeyActive, issueKey, listKeys, revokeKey } from "@/lib/services/keyService";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let counter = 0;
const uniq = (prefix: string) => `${prefix}-${++counter}`;
const now = new Date("2026-10-19T12:00:00Z");
const days = (n: number, from = now) => new Date(from.getTime() + n * 86_400_000);

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

async function makeOperator(status: "active" | "pending" | "suspended" = "active"): Promise<Operator> {
  const [row] = await t.db
    .insert(operators)
    .values({ githubId: uniq("gh"), displayName: "Operator", status })
    .returning();
  return row;
}

async function makeAgent(operator: Operator): Promise<Agent> {
  return unwrap(await createAgent(t.db, operator, { handle: uniq("agent") }));
}

async function setup() {
  const operator = await makeOperator();
  return { operator, agent: await makeAgent(operator) };
}

async function issue(operator: Operator, agent: Agent, raw: Record<string, unknown> = {}, at = now) {
  return unwrap(await issueKey(t.db, operator, agent.id, { scopes: ["read"], ...raw }, at));
}

async function count(from: string, params: unknown[] = []): Promise<number> {
  const [row] = await t.sql(`select count(*)::int as n from ${from}`, params);
  return row.n as number;
}

const activeKeys = (agentId: string, at = now) =>
  count("api_keys where agent_id = $1 and revoked_at is null and (expires_at is null or expires_at > $2)", [
    agentId,
    at,
  ]);

describe("isKeyActive", () => {
  it("is false for a revoked key", () => {
    expect(isKeyActive({ revokedAt: now, expiresAt: null }, now)).toBe(false);
  });

  it("is false for an expired key, including exactly at the expiry instant", () => {
    expect(isKeyActive({ revokedAt: null, expiresAt: days(-1) }, now)).toBe(false);
    expect(isKeyActive({ revokedAt: null, expiresAt: now }, now)).toBe(false);
  });

  it("is true for a key that has not expired, or never expires", () => {
    expect(isKeyActive({ revokedAt: null, expiresAt: new Date(now.getTime() + 1) }, now)).toBe(true);
    expect(isKeyActive({ revokedAt: null, expiresAt: null }, now)).toBe(true);
  });
});

describe("issueKey", () => {
  it("returns a well-formed key and a list item with the agreed fields only", async () => {
    const { operator, agent } = await setup();
    const { key, record } = await issue(operator, agent, { scopes: ["read", "cases:write"], label: "laptop" });
    expect(key).toMatch(/^ac_live_[0-9A-Za-z]{32}$/);
    expect(record).toMatchObject({
      agentId: agent.id,
      keyPrefix: key.slice(0, 12),
      label: "laptop",
      scopes: ["read", "cases:write"],
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(Object.keys(record).sort()).toEqual(
      ["agentId", "createdAt", "expiresAt", "id", "keyPrefix", "label", "lastUsedAt", "revokedAt", "scopes"].sort(),
    );
  });

  it("stores only the hash: the raw key appears in no column of the row", async () => {
    const { operator, agent } = await setup();
    const { key, record } = await issue(operator, agent);
    const [row] = await t.sql(`select row_to_json(k)::text as json, key_hash from api_keys k where id = $1`, [record.id]);
    expect(row.key_hash).toBe(hashApiKey(key));
    expect(String(row.json)).not.toContain(key);
    expect(String(row.json)).not.toContain(key.slice(8));
  });

  it("never puts the raw key or its hash in the audit log, and records what was issued", async () => {
    const { operator, agent } = await setup();
    const { key, record } = await issue(operator, agent, { scopes: ["read", "arguments:write"], label: "ci" });
    const rows = await t.sql(
      `select action, actor_type, actor_id, target, metadata from audit_log where target = $1`,
      [record.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "key.issued",
      actor_type: "operator",
      actor_id: operator.id,
      target: record.id,
    });
    const metadata = rows[0].metadata as { agentId: string; scopes: string[] };
    expect(metadata.agentId).toBe(agent.id);
    expect(metadata.scopes).toEqual(["read", "arguments:write"]);
    expect(await count("audit_log where metadata::text like '%' || $1 || '%'", [key])).toBe(0);
    expect(await count("audit_log where metadata::text like '%' || $1 || '%'", [hashApiKey(key)])).toBe(0);
  });

  it("expires after 90 days by default, and honours 30, 365 and never", async () => {
    const { operator, agent } = await setup();
    expect((await issue(operator, agent)).record.expiresAt).toEqual(days(90));
    expect((await issue(operator, agent, { expiresInDays: 30 })).record.expiresAt).toEqual(days(30));
    expect((await issue(operator, agent, { expiresInDays: 365 })).record.expiresAt).toEqual(days(365));
    const operator2 = await makeOperator();
    const agent2 = await makeAgent(operator2);
    expect((await issue(operator2, agent2, { expiresInDays: null })).record.expiresAt).toBeNull();
  });

  it("gives every key a different value", async () => {
    const { operator, agent } = await setup();
    const a = await issue(operator, agent);
    const b = await issue(operator, agent);
    expect(a.key).not.toBe(b.key);
    expect(a.record.id).not.toBe(b.record.id);
  });

  it("rejects invalid input and writes nothing", async () => {
    const { operator, agent } = await setup();
    for (const raw of [
      { scopes: [] },
      { scopes: ["admin"] },
      { scopes: ["read"], label: "l".repeat(61) },
      { scopes: ["read"], expiresInDays: 45 },
    ]) {
      expect(await issueKey(t.db, operator, agent.id, raw, now)).toMatchObject({ ok: false, error: "invalid" });
    }
    expect(await count("api_keys where agent_id = $1", [agent.id])).toBe(0);
    expect(await count("audit_log where actor_id = $1 and action = 'key.issued'", [operator.id])).toBe(0);
  });

  it("returns agent_not_found for another operator's agent, an unknown agent, a non-UUID and a deleted agent", async () => {
    const { operator, agent } = await setup();
    const stranger = await makeOperator();
    const call = (op: Operator, id: string) => issueKey(t.db, op, id, { scopes: ["read"] }, now);
    expect(await call(stranger, agent.id)).toMatchObject({ ok: false, error: "agent_not_found" });
    expect(await call(operator, "00000000-0000-0000-0000-000000000000")).toMatchObject({
      ok: false,
      error: "agent_not_found",
    });
    expect(await call(operator, "not-a-uuid")).toMatchObject({ ok: false, error: "agent_not_found" });
    await t.sql(`update agents set deleted_at = now() where id = $1`, [agent.id]);
    expect(await call(operator, agent.id)).toMatchObject({ ok: false, error: "agent_not_found" });
    expect(await count("api_keys where agent_id = $1", [agent.id])).toBe(0);
  });

  it("returns agent_not_active for a suspended agent", async () => {
    const { operator, agent } = await setup();
    unwrap(await setAgentStatus(t.db, operator, agent.id, "suspended"));
    expect(await issueKey(t.db, operator, agent.id, { scopes: ["read"] }, now)).toMatchObject({
      ok: false,
      error: "agent_not_active",
    });
  });

  it.each(["pending", "suspended"] as const)("refuses a %s operator", async (status) => {
    const active = await makeOperator();
    const agent = await makeAgent(active);
    await t.sql(`update operators set status = $2 where id = $1`, [active.id, status]);
    expect(await issueKey(t.db, active, agent.id, { scopes: ["read"] }, now)).toMatchObject({
      ok: false,
      error: "operator_not_active",
    });
    expect(await count("api_keys where agent_id = $1", [agent.id])).toBe(0);
  });

  it("checks the operator in the database, not the copy it was given, and refuses a deleted operator", async () => {
    const { operator, agent } = await setup();
    await t.sql(`update operators set deleted_at = now() where id = $1`, [operator.id]);
    expect(await issueKey(t.db, operator, agent.id, { scopes: ["read"] }, now)).toMatchObject({
      ok: false,
      error: "operator_not_active",
    });
  });
});

describe("the 3 active keys cap", () => {
  it("allows 3 active keys and refuses the fourth", async () => {
    const { operator, agent } = await setup();
    for (let i = 0; i < 3; i++) await issue(operator, agent);
    expect(await issueKey(t.db, operator, agent.id, { scopes: ["read"] }, now)).toMatchObject({
      ok: false,
      error: "key_limit",
    });
    expect(await activeKeys(agent.id)).toBe(3);
  });

  it("frees a slot when a key is revoked", async () => {
    const { operator, agent } = await setup();
    const first = await issue(operator, agent);
    await issue(operator, agent);
    await issue(operator, agent);
    unwrap(await revokeKey(t.db, operator, first.record.id, now));
    expect((await issueKey(t.db, operator, agent.id, { scopes: ["read"] }, now)).ok).toBe(true);
  });

  it("frees a slot when a key expires", async () => {
    const { operator, agent } = await setup();
    for (let i = 0; i < 3; i++) await issue(operator, agent, { expiresInDays: 30 });
    expect((await issueKey(t.db, operator, agent.id, { scopes: ["read"] }, days(29))).ok).toBe(false);
    expect((await issueKey(t.db, operator, agent.id, { scopes: ["read"] }, days(31))).ok).toBe(true);
  });

  it("counts each agent separately", async () => {
    const operator = await makeOperator();
    const a = await makeAgent(operator);
    const b = await makeAgent(operator);
    for (let i = 0; i < 3; i++) await issue(operator, a);
    expect((await issueKey(t.db, operator, b.id, { scopes: ["read"] }, now)).ok).toBe(true);
  });

  it("never lets simultaneous requests exceed the cap", async () => {
    const { operator, agent } = await setup();
    await issue(operator, agent);
    await issue(operator, agent);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => issueKey(t.db, operator, agent.id, { scopes: ["read"] }, now)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "key_limit")).toHaveLength(3);
    expect(await activeKeys(agent.id)).toBe(3);
  });
});

describe("listKeys", () => {
  it("lists the agent's keys newest first, including revoked and expired, without any hash", async () => {
    const { operator, agent } = await setup();
    const a = await issue(operator, agent, { label: "a" });
    const b = await issue(operator, agent, { label: "b", expiresInDays: 30 });
    const c = await issue(operator, agent, { label: "c" });
    await t.sql(`update api_keys set created_at = '2026-01-01' where id = $1`, [a.record.id]);
    await t.sql(`update api_keys set created_at = '2026-01-03' where id = $1`, [b.record.id]);
    await t.sql(`update api_keys set created_at = '2026-01-02' where id = $1`, [c.record.id]);
    unwrap(await revokeKey(t.db, operator, c.record.id, now));

    const listed = await listKeys(t.db, operator.id, agent.id);
    expect(listed.map((k) => k.label)).toEqual(["b", "c", "a"]);
    expect(listed.find((k) => k.label === "c")?.revokedAt).toEqual(now);
    for (const item of listed) expect(Object.keys(item)).not.toContain("keyHash");
  });

  it("returns nothing for another operator's agent, an unknown agent and a non-UUID", async () => {
    const { operator, agent } = await setup();
    await issue(operator, agent);
    expect(await listKeys(t.db, (await makeOperator()).id, agent.id)).toEqual([]);
    expect(await listKeys(t.db, operator.id, "00000000-0000-0000-0000-000000000000")).toEqual([]);
    expect(await listKeys(t.db, operator.id, "not-a-uuid")).toEqual([]);
  });
});

describe("revokeKey", () => {
  it("revokes a key, returns it, and writes one key.revoked audit row", async () => {
    const { operator, agent } = await setup();
    const { key, record } = await issue(operator, agent);
    const revoked = unwrap(await revokeKey(t.db, operator, record.id, now));
    expect(revoked.revokedAt).toEqual(now);
    expect(revoked.id).toBe(record.id);

    const rows = await t.sql(`select action, actor_id, metadata::text as text from audit_log where target = $1 and action = 'key.revoked'`, [
      record.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(operator.id);
    expect(String(rows[0].text)).not.toContain(key);
  });

  it("is safe to repeat: the original revocation time is kept and no second audit row is written", async () => {
    const { operator, agent } = await setup();
    const { record } = await issue(operator, agent);
    unwrap(await revokeKey(t.db, operator, record.id, now));
    const again = unwrap(await revokeKey(t.db, operator, record.id, days(5)));
    expect(again.revokedAt).toEqual(now);
    expect(await count("audit_log where target = $1 and action = 'key.revoked'", [record.id])).toBe(1);
  });

  it("returns key_not_found for another operator's key, an unknown key and a non-UUID", async () => {
    const { operator, agent } = await setup();
    const { record } = await issue(operator, agent);
    expect(await revokeKey(t.db, await makeOperator(), record.id, now)).toMatchObject({
      ok: false,
      error: "key_not_found",
    });
    expect(await revokeKey(t.db, operator, "00000000-0000-0000-0000-000000000000", now)).toMatchObject({
      ok: false,
      error: "key_not_found",
    });
    expect(await revokeKey(t.db, operator, "not-a-uuid", now)).toMatchObject({ ok: false, error: "key_not_found" });
    expect(await count("api_keys where id = $1 and revoked_at is not null", [record.id])).toBe(0);
  });

  it("lets an operator revoke the keys of a suspended or deleted agent", async () => {
    const { operator, agent } = await setup();
    const first = await issue(operator, agent);
    const second = await issue(operator, agent);
    unwrap(await setAgentStatus(t.db, operator, agent.id, "suspended"));
    expect((await revokeKey(t.db, operator, first.record.id, now)).ok).toBe(true);
    await t.sql(`update agents set deleted_at = now() where id = $1`, [agent.id]);
    expect((await revokeKey(t.db, operator, second.record.id, now)).ok).toBe(true);
  });

  it("refuses an operator that is no longer active, even with an old copy of the operator", async () => {
    const { operator, agent } = await setup();
    const { record } = await issue(operator, agent);
    await t.sql(`update operators set status = 'suspended' where id = $1`, [operator.id]);
    expect(await revokeKey(t.db, operator, record.id, now)).toMatchObject({
      ok: false,
      error: "operator_not_active",
    });
    expect(await count("api_keys where id = $1 and revoked_at is not null", [record.id])).toBe(0);
  });
});
