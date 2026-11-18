import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, operators, type Operator } from "@/db/schema";
import { setAgentStatusAsAdmin } from "@/lib/services/agentService";
import { getKillSwitch, setKillSwitch } from "@/lib/services/killSwitchService";
import { createTestDb, type TestDb } from "../helpers/db";
import { createFixtures } from "../helpers/fixtures";

// N10 Task 1 (AC-1007): the global switch lives in system_flags, every change is audited with the admin's id, and an
// admin can suspend or reactivate any agent. Run as the application role, so row level security applies.

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

async function makeOperator(
  role: "operator" | "admin" = "admin",
  status: "active" | "pending" | "suspended" = "active",
): Promise<Operator> {
  const [row] = await t.db
    .insert(operators)
    .values({ githubId: f.uniq("gh"), displayName: "Operator", role, status })
    .returning();
  return row;
}

const REASON = "Injection spike seen in the flag rate";
const auditRows = (action: string, actor?: string) =>
  actor
    ? t.sql("select * from audit_log where action = $1 and actor_id = $2 order by created_at", [action, actor])
    : t.sql("select * from audit_log where action = $1 order by created_at", [action]);
const flagRow = async () => t.sql("select * from system_flags where key = 'kill_switch'");

describe("getKillSwitch", () => {
  it("is off when nothing has ever been set", async () => {
    expect(await getKillSwitch(t.db)).toBe(false);
  });
});

describe("setKillSwitch", () => {
  it("turns the switch on for an admin, and reads it back", async () => {
    const admin = await makeOperator();
    const result = await setKillSwitch(t.db, admin, true, REASON);
    expect(result).toEqual({ ok: true, value: { on: true } });
    expect(await getKillSwitch(t.db)).toBe(true);
    const [row] = await flagRow();
    expect(row.value).toBe(true);
    expect(row.updated_by).toBe(admin.id);
  });

  it("writes one audit row naming the admin, the new value and the reason", async () => {
    const admin = await makeOperator();
    await setKillSwitch(t.db, admin, false, REASON);
    await setKillSwitch(t.db, admin, true, REASON);
    const rows = await auditRows("killswitch.set", admin.id);
    expect(rows).toHaveLength(2);
    const last = rows[rows.length - 1];
    expect(last.actor_type).toBe("operator");
    expect(last.target).toBe("kill_switch");
    expect(last.metadata).toMatchObject({ value: true, reason: REASON });
  });

  it("turns the switch off again", async () => {
    const admin = await makeOperator();
    await setKillSwitch(t.db, admin, true, REASON);
    const result = await setKillSwitch(t.db, admin, false, "The incident is over, traffic is normal");
    expect(result).toEqual({ ok: true, value: { on: false } });
    expect(await getKillSwitch(t.db)).toBe(false);
  });

  it("writes no second audit row when the value does not change", async () => {
    const admin = await makeOperator();
    await setKillSwitch(t.db, admin, true, REASON);
    const before = (await auditRows("killswitch.set", admin.id)).length;
    const again = await setKillSwitch(t.db, admin, true, REASON);
    expect(again).toEqual({ ok: true, value: { on: true } });
    expect((await auditRows("killswitch.set", admin.id)).length).toBe(before);
  });

  it("keeps one row in the table however often it is changed", async () => {
    const admin = await makeOperator();
    await setKillSwitch(t.db, admin, false, REASON);
    await setKillSwitch(t.db, admin, true, REASON);
    expect(await flagRow()).toHaveLength(1);
  });

  it.each([
    ["an ordinary operator", () => makeOperator("operator")],
    ["a suspended admin", () => makeOperator("admin", "suspended")],
    ["an admin who is not yet active", () => makeOperator("admin", "pending")],
  ])("refuses %s and changes nothing", async (_label, make) => {
    const before = await getKillSwitch(t.db);
    const rows = (await auditRows("killswitch.set")).length;
    const who = await make();
    const result = await setKillSwitch(t.db, who, !before, REASON);
    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(await getKillSwitch(t.db)).toBe(before);
    expect((await auditRows("killswitch.set")).length).toBe(rows);
  });

  it("uses the operator's current role from the database, not the object it was handed", async () => {
    const admin = await makeOperator();
    await t.db.update(operators).set({ role: "operator" }).where(eq(operators.id, admin.id));
    const stale = { ...admin, role: "admin" as const };
    const result = await setKillSwitch(t.db, stale, true, REASON);
    expect(result).toEqual({ ok: false, error: "forbidden" });
  });

  it.each([
    ["nine characters", "123456789"],
    ["only spaces around a short word", "      short      "],
    ["empty", ""],
    ["two hundred and one characters", "x".repeat(201)],
  ])("refuses a reason of %s", async (_label, reason) => {
    const admin = await makeOperator();
    const before = await getKillSwitch(t.db);
    const result = await setKillSwitch(t.db, admin, !before, reason);
    expect(result).toEqual({ ok: false, error: "invalid_reason" });
    expect(await getKillSwitch(t.db)).toBe(before);
  });

  it("accepts a reason of exactly ten and of exactly two hundred characters", async () => {
    const admin = await makeOperator();
    expect((await setKillSwitch(t.db, admin, true, "1234567890")).ok).toBe(true);
    expect((await setKillSwitch(t.db, admin, false, "y".repeat(200))).ok).toBe(true);
  });

  it("scrubs a bearer token that was typed into the reason, so no key reaches the audit table", async () => {
    const admin = await makeOperator();
    const token = "abcdefghijklmnopqrstuvwxyz0123456789";
    await setKillSwitch(t.db, admin, true, `Stopping it, the key was Bearer ${token} in the log`);
    const rows = await auditRows("killswitch.set", admin.id);
    expect(JSON.stringify(rows[rows.length - 1].metadata)).not.toContain(token);
  });
});

describe("setAgentStatusAsAdmin", () => {
  it("suspends an agent of another operator and writes an audit row naming the admin", async () => {
    const admin = await makeOperator();
    const { agent } = await f.makeAgent();
    const result = await setAgentStatusAsAdmin(t.db, admin, agent.id, "suspended", REASON);
    expect(result.ok).toBe(true);
    const [row] = await t.db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row.status).toBe("suspended");
    const audit = await auditRows("agent.suspended_by_admin", admin.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].target).toBe(agent.id);
    expect(audit[0].metadata).toMatchObject({ handle: agent.handle, reason: REASON });
  });

  it("records an admin's suspension under a different action than the owner's, so the two can be told apart", async () => {
    const admin = await makeOperator();
    const { agent } = await f.makeAgent();
    await setAgentStatusAsAdmin(t.db, admin, agent.id, "suspended", REASON);
    expect(await f.count("audit_log where action = 'agent.suspended' and target = $1", [agent.id])).toBe(0);
  });

  it("reactivates the agent again", async () => {
    const admin = await makeOperator();
    const { agent } = await f.makeAgent();
    await setAgentStatusAsAdmin(t.db, admin, agent.id, "suspended", REASON);
    const result = await setAgentStatusAsAdmin(t.db, admin, agent.id, "active", "Checked and cleared by the admin");
    expect(result.ok).toBe(true);
    const [row] = await t.db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row.status).toBe("active");
    expect(await auditRows("agent.reactivated_by_admin", admin.id)).toHaveLength(1);
  });

  it("writes no second audit row for a repeated change", async () => {
    const admin = await makeOperator();
    const { agent } = await f.makeAgent();
    await setAgentStatusAsAdmin(t.db, admin, agent.id, "suspended", REASON);
    const again = await setAgentStatusAsAdmin(t.db, admin, agent.id, "suspended", REASON);
    expect(again.ok).toBe(true);
    expect(await f.count("audit_log where action = 'agent.suspended_by_admin' and target = $1", [agent.id])).toBe(1);
  });

  it("refuses an operator who is not an active admin", async () => {
    const operator = await makeOperator("operator");
    const { agent } = await f.makeAgent();
    expect(await setAgentStatusAsAdmin(t.db, operator, agent.id, "suspended", REASON)).toEqual({ ok: false, error: "forbidden" });
    const [row] = await t.db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row.status).toBe("active");
  });

  it.each([
    ["an unknown id", "00000000-0000-4000-8000-000000000999"],
    ["something that is not an id", "not-an-id"],
  ])("answers agent_not_found for %s", async (_label, id) => {
    const admin = await makeOperator();
    expect(await setAgentStatusAsAdmin(t.db, admin, id, "suspended", REASON)).toEqual({ ok: false, error: "agent_not_found" });
  });

  it("does not find a deleted agent", async () => {
    const admin = await makeOperator();
    const { agent } = await f.makeAgent();
    await t.db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, agent.id));
    expect(await setAgentStatusAsAdmin(t.db, admin, agent.id, "suspended", REASON)).toEqual({ ok: false, error: "agent_not_found" });
  });

  it("refuses a reason that is too short, and changes nothing", async () => {
    const admin = await makeOperator();
    const { agent } = await f.makeAgent();
    expect(await setAgentStatusAsAdmin(t.db, admin, agent.id, "suspended", "short")).toEqual({ ok: false, error: "invalid_reason" });
    const [row] = await t.db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row.status).toBe("active");
  });
});

describe("the system_flags table and the application role", () => {
  it("lets the application role read and write it, and nobody else", async () => {
    await t.sql("reset role");
    try {
      await t.sql("set role nobody");
      await expect(t.sql("select * from public.system_flags")).rejects.toMatchObject({ code: "42501" });
      await t.sql("reset role");
      await t.sql("set role app_server");
      await expect(t.sql("select * from public.system_flags")).resolves.toBeDefined();
    } finally {
      await t.sql("reset role");
      await t.sql("set role app_server");
    }
  });

  it("does not let the application role delete the flag", async () => {
    await expect(t.sql("delete from public.system_flags")).rejects.toMatchObject({ code: "42501" });
  });
});
