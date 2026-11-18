import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, operators, type Operator } from "@/db/schema";
import { setAgentStatusCore, setKillSwitchCore } from "@/lib/admin/killSwitchCore";
import type { ActionDeps } from "@/lib/dashboard/actionsCore";
import { getKillSwitch } from "@/lib/services/killSwitchService";
import { createTestDb, type TestDb } from "../helpers/db";
import { createFixtures } from "../helpers/fixtures";

// N10 Task 1 (AC-1007): the form handlers behind /admin/kill-switch. Order, as for every admin action: same-origin
// check, then the admin check (anyone else gets the answer a missing sign-in gets), then the input, then the service.

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const ORIGIN = "http://localhost:3000";
const REASON = "Flag rate is climbing, stopping agents";

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

async function makeOperator(role: "operator" | "admin" = "admin"): Promise<Operator> {
  const [row] = await t.db
    .insert(operators)
    .values({ githubId: f.uniq("gh"), displayName: "Operator", role, status: "active" })
    .returning();
  return row;
}

const deps = (operator: Operator | null, over: Partial<ActionDeps> = {}): ActionDeps => ({
  db: t.db,
  operator,
  headers: new Headers({ origin: ORIGIN }),
  expectedOrigin: ORIGIN,
  ...over,
});
const crossSite = { headers: new Headers({ origin: "https://evil.example" }) };
const noOrigin = { headers: new Headers() };

const codeOf = (result: { ok: boolean; error?: { code: string } }): string => {
  if (result.ok) throw new Error("expected a failure");
  return result.error?.code ?? "";
};

describe("setKillSwitchCore", () => {
  it("turns the switch on for an admin", async () => {
    const admin = await makeOperator();
    const result = await setKillSwitchCore(deps(admin), { value: "on", reason: REASON });
    expect(result).toEqual({ ok: true, value: { on: true } });
    expect(await getKillSwitch(t.db)).toBe(true);
  });

  it("turns the switch off for an admin", async () => {
    const admin = await makeOperator();
    await setKillSwitchCore(deps(admin), { value: "on", reason: REASON });
    const result = await setKillSwitchCore(deps(admin), { value: "off", reason: "Cleared, back to normal traffic" });
    expect(result).toEqual({ ok: true, value: { on: false } });
    expect(await getKillSwitch(t.db)).toBe(false);
  });

  it.each([
    ["a different origin", crossSite],
    ["no origin", noOrigin],
  ])("refuses %s before anything else, even for an admin", async (_label, over) => {
    const admin = await makeOperator();
    const before = await getKillSwitch(t.db);
    const result = await setKillSwitchCore(deps(admin, over), { value: before ? "off" : "on", reason: REASON });
    expect(codeOf(result)).toBe("origin_mismatch");
    expect(await getKillSwitch(t.db)).toBe(before);
  });

  it.each([
    ["nobody signed in", () => Promise.resolve(null)],
    ["an ordinary operator", () => makeOperator("operator")],
  ])("answers %s as a missing sign-in, so nothing is revealed", async (_label, make) => {
    const before = await getKillSwitch(t.db);
    const result = await setKillSwitchCore(deps(await make()), { value: before ? "off" : "on", reason: REASON });
    expect(codeOf(result)).toBe("not_signed_in");
    expect(await getKillSwitch(t.db)).toBe(before);
  });

  it.each([
    ["a value that is neither on nor off", { value: "maybe", reason: REASON }],
    ["an empty value", { value: "", reason: REASON }],
    ["a missing reason", { value: "on", reason: "" }],
    ["a reason that is too short", { value: "on", reason: "too short" }],
    ["a reason that is too long", { value: "on", reason: "z".repeat(201) }],
  ])("refuses %s", async (_label, input) => {
    const admin = await makeOperator();
    const before = await getKillSwitch(t.db);
    const result = await setKillSwitchCore(deps(admin), input);
    expect(["invalid", "invalid_reason"]).toContain(codeOf(result));
    expect(await getKillSwitch(t.db)).toBe(before);
  });
});

describe("setAgentStatusCore", () => {
  it("suspends and reactivates an agent for an admin", async () => {
    const admin = await makeOperator();
    const { agent } = await f.makeAgent();
    const suspended = await setAgentStatusCore(deps(admin), { agentId: agent.id, status: "suspended", reason: REASON });
    expect(suspended).toEqual({ ok: true, value: { status: "suspended" } });
    const reactivated = await setAgentStatusCore(deps(admin), { agentId: agent.id, status: "active", reason: "Looked at it, all good" });
    expect(reactivated).toEqual({ ok: true, value: { status: "active" } });
    const [row] = await t.db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row.status).toBe("active");
  });

  it.each([
    ["a different origin", crossSite],
    ["no origin", noOrigin],
  ])("refuses %s before anything else", async (_label, over) => {
    const admin = await makeOperator();
    const { agent } = await f.makeAgent();
    const result = await setAgentStatusCore(deps(admin, over), { agentId: agent.id, status: "suspended", reason: REASON });
    expect(codeOf(result)).toBe("origin_mismatch");
    const [row] = await t.db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row.status).toBe("active");
  });

  it("answers an ordinary operator as a missing sign-in", async () => {
    const operator = await makeOperator("operator");
    const { agent } = await f.makeAgent();
    const result = await setAgentStatusCore(deps(operator), { agentId: agent.id, status: "suspended", reason: REASON });
    expect(codeOf(result)).toBe("not_signed_in");
  });

  it.each([
    ["a status that is neither", { status: "banned" }],
    ["an empty status", { status: "" }],
    ["a short reason", { status: "suspended", reason: "no" }],
  ])("refuses %s", async (_label, over) => {
    const admin = await makeOperator();
    const { agent } = await f.makeAgent();
    const input: { status: string; reason: string } = { status: "suspended", reason: REASON };
    const result = await setAgentStatusCore(deps(admin), { agentId: agent.id, ...input, ...over });
    expect(["invalid", "invalid_reason"]).toContain(codeOf(result));
    const [row] = await t.db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row.status).toBe("active");
  });

  it("answers an unknown agent with a fixed code", async () => {
    const admin = await makeOperator();
    const result = await setAgentStatusCore(deps(admin), {
      agentId: "00000000-0000-4000-8000-000000000999",
      status: "suspended",
      reason: REASON,
    });
    expect(codeOf(result)).toBe("agent_not_found");
  });
});
