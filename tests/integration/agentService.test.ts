import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operators, type Operator } from "@/db/schema";
import { createAgent, getOwnedAgent, listAgents, setAgentStatus } from "@/lib/services/agentService";
import { writeAudit } from "@/lib/services/auditService";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let counter = 0;
const uniq = (prefix: string) => `${prefix}-${++counter}`;

beforeAll(async () => {
  t = await createTestDb();
  // The whole file runs with only the application role's privileges.
  await t.sql("set role app_server");
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

async function makeOperator(status: "active" | "pending" | "suspended" = "active"): Promise<Operator> {
  const [row] = await t.db
    .insert(operators)
    .values({ githubId: uniq("gh"), displayName: "Operator", status })
    .returning();
  return row;
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.value;
}

async function count(from: string, params: unknown[] = []): Promise<number> {
  const [row] = await t.sql(`select count(*)::int as n from ${from}`, params);
  return row.n as number;
}

const agentsOf = (operatorId: string) => count("agents where operator_id = $1", [operatorId]);

describe("createAgent", () => {
  it("creates an active agent for an active operator", async () => {
    const operator = await makeOperator();
    const agent = unwrap(
      await createAgent(t.db, operator, {
        handle: "Scribe-01",
        model: "model-a",
        framework: "framework-b",
        description: "Files cases.",
      }),
    );
    expect(agent).toMatchObject({
      operatorId: operator.id,
      handle: "scribe-01",
      model: "model-a",
      framework: "framework-b",
      description: "Files cases.",
      status: "active",
    });
    expect(await agentsOf(operator.id)).toBe(1);
  });

  it("writes an agent.created audit row that holds the handle and nothing sensitive", async () => {
    const operator = await makeOperator();
    const agent = unwrap(
      await createAgent(t.db, operator, { handle: uniq("audited"), description: "private notes here" }),
    );
    const rows = await t.sql(
      `select action, actor_type, actor_id, target, metadata from audit_log where target = $1`,
      [agent.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "agent.created",
      actor_type: "operator",
      actor_id: operator.id,
      target: agent.id,
    });
    expect((rows[0].metadata as { handle: string }).handle).toBe(agent.handle);
    expect(JSON.stringify(rows[0].metadata)).not.toContain("private notes here");
  });

  it.each(["pending", "suspended"] as const)("refuses a %s operator and writes nothing", async (status) => {
    const operator = await makeOperator(status);
    const handle = uniq("refused");
    const result = await createAgent(t.db, operator, { handle });
    expect(result).toMatchObject({ ok: false, error: "operator_not_active" });
    expect(await agentsOf(operator.id)).toBe(0);
    expect(await count("audit_log where actor_id = $1", [operator.id])).toBe(0);
  });

  it("checks the operator's current status in the database, not the object it was given", async () => {
    const stale = await makeOperator("active");
    await t.sql(`update operators set status = 'suspended' where id = $1`, [stale.id]);
    expect(await createAgent(t.db, stale, { handle: uniq("stale") })).toMatchObject({
      ok: false,
      error: "operator_not_active",
    });
  });

  it("refuses an operator that has been deleted", async () => {
    const operator = await makeOperator();
    await t.sql(`update operators set deleted_at = now() where id = $1`, [operator.id]);
    expect(await createAgent(t.db, operator, { handle: uniq("gone") })).toMatchObject({
      ok: false,
      error: "operator_not_active",
    });
  });

  it("rejects invalid input and writes nothing", async () => {
    const operator = await makeOperator();
    const result = await createAgent(t.db, operator, { handle: "admin" });
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(await agentsOf(operator.id)).toBe(0);
  });

  it("allows 5 agents and refuses the sixth", async () => {
    const operator = await makeOperator();
    for (let i = 0; i < 5; i++) unwrap(await createAgent(t.db, operator, { handle: uniq("cap") }));
    expect(await createAgent(t.db, operator, { handle: uniq("cap") })).toMatchObject({
      ok: false,
      error: "agent_limit",
    });
    expect(await agentsOf(operator.id)).toBe(5);
  });

  it("counts suspended agents toward the cap", async () => {
    const operator = await makeOperator();
    const first = unwrap(await createAgent(t.db, operator, { handle: uniq("cap") }));
    for (let i = 0; i < 4; i++) unwrap(await createAgent(t.db, operator, { handle: uniq("cap") }));
    unwrap(await setAgentStatus(t.db, operator, first.id, "suspended"));
    expect(await createAgent(t.db, operator, { handle: uniq("cap") })).toMatchObject({
      ok: false,
      error: "agent_limit",
    });
  });

  it("does not count a soft-deleted agent toward the cap", async () => {
    const operator = await makeOperator();
    const first = unwrap(await createAgent(t.db, operator, { handle: uniq("cap") }));
    for (let i = 0; i < 4; i++) unwrap(await createAgent(t.db, operator, { handle: uniq("cap") }));
    await t.sql(`update agents set deleted_at = now() where id = $1`, [first.id]);
    expect((await createAgent(t.db, operator, { handle: uniq("cap") })).ok).toBe(true);
  });

  it("never lets simultaneous requests exceed the cap", async () => {
    const operator = await makeOperator();
    const results = await Promise.all(
      Array.from({ length: 7 }, () => createAgent(t.db, operator, { handle: uniq("race") })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.error === "agent_limit")).toHaveLength(2);
    expect(await agentsOf(operator.id)).toBe(5);
  });

  it("keeps handles unique, case-insensitively and across operators", async () => {
    const handle = uniq("taken");
    unwrap(await createAgent(t.db, await makeOperator(), { handle }));
    const other = await makeOperator();
    expect(await createAgent(t.db, other, { handle })).toMatchObject({ ok: false, error: "handle_taken" });
    expect(await createAgent(t.db, other, { handle: handle.toUpperCase() })).toMatchObject({
      ok: false,
      error: "handle_taken",
    });
  });

  it("keeps a soft-deleted agent's handle taken", async () => {
    const operator = await makeOperator();
    const handle = uniq("retired");
    const agent = unwrap(await createAgent(t.db, operator, { handle }));
    await t.sql(`update agents set deleted_at = now() where id = $1`, [agent.id]);
    expect(await createAgent(t.db, operator, { handle })).toMatchObject({ ok: false, error: "handle_taken" });
  });
});

describe("listAgents and getOwnedAgent", () => {
  it("lists only the operator's own agents, newest first, including suspended and excluding deleted", async () => {
    const operator = await makeOperator();
    const a = unwrap(await createAgent(t.db, operator, { handle: uniq("list") }));
    const b = unwrap(await createAgent(t.db, operator, { handle: uniq("list") }));
    const c = unwrap(await createAgent(t.db, operator, { handle: uniq("list") }));
    const d = unwrap(await createAgent(t.db, operator, { handle: uniq("list") }));
    unwrap(await createAgent(t.db, await makeOperator(), { handle: uniq("someone-else") }));

    await t.sql(`update agents set created_at = '2026-01-01' where id = $1`, [a.id]);
    await t.sql(`update agents set created_at = '2026-01-03' where id = $1`, [b.id]);
    await t.sql(`update agents set created_at = '2026-01-02' where id = $1`, [c.id]);
    await t.sql(`update agents set deleted_at = now() where id = $1`, [d.id]);
    unwrap(await setAgentStatus(t.db, operator, c.id, "suspended"));

    const listed = await listAgents(t.db, operator.id);
    expect(listed.map((agent) => agent.id)).toEqual([b.id, c.id, a.id]);
    expect(listed.find((agent) => agent.id === c.id)?.status).toBe("suspended");
  });

  it("returns an empty list for an operator with no agents", async () => {
    expect(await listAgents(t.db, (await makeOperator()).id)).toEqual([]);
  });

  it("returns an owned agent, and null for anyone else's, a deleted one or an unknown id", async () => {
    const owner = await makeOperator();
    const agent = unwrap(await createAgent(t.db, owner, { handle: uniq("owned") }));
    expect((await getOwnedAgent(t.db, owner.id, agent.id))?.id).toBe(agent.id);
    expect(await getOwnedAgent(t.db, (await makeOperator()).id, agent.id)).toBeNull();
    expect(await getOwnedAgent(t.db, owner.id, "00000000-0000-0000-0000-000000000000")).toBeNull();
    await t.sql(`update agents set deleted_at = now() where id = $1`, [agent.id]);
    expect(await getOwnedAgent(t.db, owner.id, agent.id)).toBeNull();
  });

  it("returns null, without throwing, for an id that is not a UUID", async () => {
    expect(await getOwnedAgent(t.db, (await makeOperator()).id, "not-a-uuid")).toBeNull();
  });
});

describe("setAgentStatus", () => {
  it("suspends and reactivates an agent, with an audit row for each", async () => {
    const operator = await makeOperator();
    const agent = unwrap(await createAgent(t.db, operator, { handle: uniq("flip") }));

    expect(unwrap(await setAgentStatus(t.db, operator, agent.id, "suspended")).status).toBe("suspended");
    expect(unwrap(await setAgentStatus(t.db, operator, agent.id, "active")).status).toBe("active");

    const rows = await t.sql(`select action from audit_log where target = $1 order by created_at, action`, [
      agent.id,
    ]);
    expect(rows.map((row) => row.action).sort()).toEqual(
      ["agent.created", "agent.reactivated", "agent.suspended"].sort(),
    );
  });

  it("writes one audit row when the same change is requested twice", async () => {
    const operator = await makeOperator();
    const agent = unwrap(await createAgent(t.db, operator, { handle: uniq("twice") }));
    unwrap(await setAgentStatus(t.db, operator, agent.id, "suspended"));
    unwrap(await setAgentStatus(t.db, operator, agent.id, "suspended"));
    expect(await count("audit_log where target = $1 and action = 'agent.suspended'", [agent.id])).toBe(1);
  });

  it("refuses to touch another operator's agent", async () => {
    const owner = await makeOperator();
    const agent = unwrap(await createAgent(t.db, owner, { handle: uniq("theirs") }));
    const result = await setAgentStatus(t.db, await makeOperator(), agent.id, "suspended");
    expect(result).toMatchObject({ ok: false, error: "agent_not_found" });
    expect((await getOwnedAgent(t.db, owner.id, agent.id))?.status).toBe("active");
  });

  it("returns agent_not_found for a deleted agent and for an id that is not a UUID", async () => {
    const operator = await makeOperator();
    const agent = unwrap(await createAgent(t.db, operator, { handle: uniq("deleted") }));
    await t.sql(`update agents set deleted_at = now() where id = $1`, [agent.id]);
    expect(await setAgentStatus(t.db, operator, agent.id, "suspended")).toMatchObject({
      ok: false,
      error: "agent_not_found",
    });
    expect(await setAgentStatus(t.db, operator, "not-a-uuid", "suspended")).toMatchObject({
      ok: false,
      error: "agent_not_found",
    });
  });

  it("refuses when the operator is no longer active, even with an old copy of the operator", async () => {
    const stale = await makeOperator();
    const agent = unwrap(await createAgent(t.db, stale, { handle: uniq("frozen") }));
    await t.sql(`update operators set status = 'suspended' where id = $1`, [stale.id]);
    expect(await setAgentStatus(t.db, stale, agent.id, "active")).toMatchObject({
      ok: false,
      error: "operator_not_active",
    });
  });
});

describe("writeAudit", () => {
  it("writes an operator-attributed row", async () => {
    const operator = await makeOperator();
    const target = uniq("target");
    await writeAudit(t.db, {
      actorOperatorId: operator.id,
      action: "key.revoked",
      target,
      metadata: { scopes: ["read"] },
    });
    const [row] = await t.sql(`select actor_type, actor_id, action, target, metadata from audit_log where target = $1`, [
      target,
    ]);
    expect(row).toMatchObject({ actor_type: "operator", actor_id: operator.id, action: "key.revoked", target });
    expect(row.metadata).toEqual({ scopes: ["read"] });
  });

  it("scrubs secrets out of metadata before storing it", async () => {
    const operator = await makeOperator();
    const target = uniq("scrubbed");
    const apiKey = `ac_live_${"A".repeat(32)}`;
    await writeAudit(t.db, {
      actorOperatorId: operator.id,
      action: "key.issued",
      target,
      metadata: { authorization: "Bearer abc.def.ghi", note: `the key is ${apiKey}`, scopes: ["read"] },
    });
    const [row] = await t.sql(`select metadata::text as text from audit_log where target = $1`, [target]);
    expect(row.text).not.toContain("abc.def.ghi");
    expect(row.text).not.toContain(apiKey);
    expect(row.text).toContain("read");
  });

  it("writes a row with no metadata", async () => {
    const operator = await makeOperator();
    const target = uniq("bare");
    await writeAudit(t.db, { actorOperatorId: operator.id, action: "agent.created", target });
    expect(await count("audit_log where target = $1", [target])).toBe(1);
  });
});
