import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operators, type Operator } from "@/db/schema";
import { hashApiKey } from "@/lib/auth/apiKey";
import {
  issueKeyCore,
  registerAgentCore,
  revokeKeyCore,
  setAgentStatusCore,
  type ActionDeps,
} from "@/lib/dashboard/actionsCore";
import { createAgent } from "@/lib/services/agentService";
import { issueKey } from "@/lib/services/keyService";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let counter = 0;
const uniq = (prefix: string) => `${prefix}-${++counter}`;
const ORIGIN = "http://localhost:3000";
const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 86_400_000;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.value;
}

async function makeOperator(status: "active" | "pending" = "active"): Promise<Operator> {
  const [row] = await t.db.insert(operators).values({ githubId: uniq("gh"), displayName: "Operator", status }).returning();
  return row;
}

const deps = (operator: Operator | null, over: Partial<ActionDeps> = {}): ActionDeps => ({
  db: t.db,
  operator,
  headers: new Headers({ origin: ORIGIN }),
  expectedOrigin: ORIGIN,
  now: NOW,
  ...over,
});
const crossSite = { headers: new Headers({ origin: "https://evil.example" }) };
const noOrigin = { headers: new Headers() };

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

async function count(from: string, params: unknown[] = []): Promise<number> {
  const [row] = await t.sql(`select count(*)::int as n from ${from}`, params);
  return row.n as number;
}

async function setup() {
  const operator = await makeOperator();
  const agent = unwrap(await createAgent(t.db, operator, { handle: uniq("agent") }));
  return { operator, agent };
}

function expectError(result: { ok: boolean; error?: { code: string; message: string; hint: string } }, code: string) {
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe(code);
  expect(result.error?.message.length).toBeGreaterThan(0);
  expect(result.error?.hint.length).toBeGreaterThan(0);
}

describe("registerAgentCore", () => {
  it("registers an agent and returns its id and handle", async () => {
    const operator = await makeOperator();
    const result = await registerAgentCore(deps(operator), form([["handle", "Scribe-01"], ["model", "m"]]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.handle).toBe("scribe-01");
    expect(await count("agents where operator_id = $1", [operator.id])).toBe(1);
  });

  it("reports invalid input with a message per field", async () => {
    const operator = await makeOperator();
    const result = await registerAgentCore(deps(operator), form([["handle", "admin"]]));
    expectError(result, "invalid");
    if (!result.ok) expect(result.fieldErrors?.handle).toBeTruthy();
    expect(await count("agents where operator_id = $1", [operator.id])).toBe(0);
  });

  it("explains a pending operator, a taken handle and the agent limit", async () => {
    expectError(await registerAgentCore(deps(await makeOperator("pending")), form([["handle", uniq("p")]])), "operator_not_active");

    const operator = await makeOperator();
    const handle = uniq("taken");
    unwrap(await createAgent(t.db, await makeOperator(), { handle }));
    expectError(await registerAgentCore(deps(operator), form([["handle", handle]])), "handle_taken");

    for (let i = 0; i < 5; i++) unwrap(await createAgent(t.db, operator, { handle: uniq("cap") }));
    expectError(await registerAgentCore(deps(operator), form([["handle", uniq("sixth")]])), "agent_limit");
  });

  it("refuses a cross-site or origin-less request before doing anything", async () => {
    const operator = await makeOperator();
    expectError(await registerAgentCore(deps(operator, crossSite), form([["handle", uniq("x")]])), "origin_mismatch");
    expectError(await registerAgentCore(deps(operator, noOrigin), form([["handle", uniq("x")]])), "origin_mismatch");
    expect(await count("agents where operator_id = $1", [operator.id])).toBe(0);
  });

  it("asks a signed-out visitor to sign in, and checks the origin first", async () => {
    expectError(await registerAgentCore(deps(null), form([["handle", uniq("x")]])), "not_signed_in");
    expectError(await registerAgentCore(deps(null, crossSite), form([["handle", uniq("x")]])), "origin_mismatch");
  });
});

describe("setAgentStatusCore", () => {
  it("suspends and reactivates, returning the new status", async () => {
    const { operator, agent } = await setup();
    const suspended = await setAgentStatusCore(deps(operator), agent.id, "suspended");
    expect(suspended.ok && suspended.value.status).toBe("suspended");
    const active = await setAgentStatusCore(deps(operator), agent.id, "active");
    expect(active.ok && active.value.status).toBe("active");
  });

  it("will not touch another operator's agent", async () => {
    const { agent } = await setup();
    expectError(await setAgentStatusCore(deps(await makeOperator()), agent.id, "suspended"), "agent_not_found");
  });

  it("refuses a cross-site request and leaves the agent alone", async () => {
    const { operator, agent } = await setup();
    expectError(await setAgentStatusCore(deps(operator, crossSite), agent.id, "suspended"), "origin_mismatch");
    const [row] = await t.sql(`select status from agents where id = $1`, [agent.id]);
    expect(row.status).toBe("active");
  });

  it("asks a signed-out visitor to sign in", async () => {
    const { agent } = await setup();
    expectError(await setAgentStatusCore(deps(null), agent.id, "suspended"), "not_signed_in");
  });
});

describe("issueKeyCore", () => {
  const scopesForm = (extra: Array<[string, string]> = []) =>
    form([["scopes", "read"], ["scopes", "cases:write"], ...extra]);

  it("returns the key once, with its fingerprint, scopes, expiry and id", async () => {
    const { operator, agent } = await setup();
    const result = await issueKeyCore(deps(operator), agent.id, scopesForm([["expiresInDays", "30"], ["label", "laptop"]]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.key).toMatch(/^ac_live_[0-9A-Za-z]{32}$/);
    expect(result.value.fingerprint).toBe(`${result.value.key.slice(0, 12)}…`);
    expect(result.value.scopes).toEqual(["read", "cases:write"]);
    expect(result.value.expiresAt).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString());
    expect(result.value.label).toBe("laptop");
    expect(result.value.keyId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("expires after 90 days when no expiry is chosen, and never when told so", async () => {
    const { operator, agent } = await setup();
    const byDefault = await issueKeyCore(deps(operator), agent.id, scopesForm());
    expect(byDefault.ok && byDefault.value.expiresAt).toBe(new Date(NOW.getTime() + 90 * DAY).toISOString());
    const never = await issueKeyCore(deps(operator), agent.id, scopesForm([["expiresInDays", "never"]]));
    expect(never.ok && never.value.expiresAt).toBeNull();
  });

  it("puts the raw key in the result exactly once and never its hash", async () => {
    const { operator, agent } = await setup();
    const result = await issueKeyCore(deps(operator), agent.id, scopesForm());
    if (!result.ok) throw new Error("expected ok");
    const json = JSON.stringify(result);
    expect(json.split(result.value.key).length - 1).toBe(1);
    expect(json).not.toContain(hashApiKey(result.value.key));
  });

  it("reports missing scopes per field and issues nothing", async () => {
    const { operator, agent } = await setup();
    const result = await issueKeyCore(deps(operator), agent.id, form([["label", "x"]]));
    expectError(result, "invalid");
    if (!result.ok) expect(result.fieldErrors?.scopes).toBeTruthy();
    expect(await count("api_keys where agent_id = $1", [agent.id])).toBe(0);
  });

  it("explains the key limit, a stranger's agent and a suspended agent", async () => {
    const { operator, agent } = await setup();
    for (let i = 0; i < 3; i++) unwrap(await issueKey(t.db, operator, agent.id, { scopes: ["read"] }, NOW));
    expectError(await issueKeyCore(deps(operator), agent.id, scopesForm()), "key_limit");

    expectError(await issueKeyCore(deps(await makeOperator()), agent.id, scopesForm()), "agent_not_found");

    const second = await setup();
    await setAgentStatusCore(deps(second.operator), second.agent.id, "suspended");
    expectError(await issueKeyCore(deps(second.operator), second.agent.id, scopesForm()), "agent_not_active");
  });

  it("refuses a cross-site request and issues nothing", async () => {
    const { operator, agent } = await setup();
    expectError(await issueKeyCore(deps(operator, crossSite), agent.id, scopesForm()), "origin_mismatch");
    expect(await count("api_keys where agent_id = $1", [agent.id])).toBe(0);
  });

  it("asks a signed-out visitor to sign in", async () => {
    const { agent } = await setup();
    expectError(await issueKeyCore(deps(null), agent.id, scopesForm()), "not_signed_in");
  });

  it("never echoes a bad agent id back", async () => {
    const { operator } = await setup();
    const result = await issueKeyCore(deps(operator), "x<script>LEAKME", scopesForm());
    expectError(result, "agent_not_found");
    expect(JSON.stringify(result)).not.toContain("LEAKME");
  });
});

describe("revokeKeyCore", () => {
  it("revokes a key and returns its id and revocation time", async () => {
    const { operator, agent } = await setup();
    const issued = unwrap(await issueKey(t.db, operator, agent.id, { scopes: ["read"] }, NOW));
    const result = await revokeKeyCore(deps(operator), issued.record.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.keyId).toBe(issued.record.id);
      expect(result.value.revokedAt).toBe(NOW.toISOString());
    }
  });

  it("will not revoke another operator's key, or an unknown or malformed one", async () => {
    const { operator, agent } = await setup();
    const issued = unwrap(await issueKey(t.db, operator, agent.id, { scopes: ["read"] }, NOW));
    expectError(await revokeKeyCore(deps(await makeOperator()), issued.record.id), "key_not_found");
    expectError(await revokeKeyCore(deps(operator), "not-a-uuid-LEAKME"), "key_not_found");
    expect(JSON.stringify(await revokeKeyCore(deps(operator), "not-a-uuid-LEAKME"))).not.toContain("LEAKME");
  });

  it("refuses a cross-site request and leaves the key active", async () => {
    const { operator, agent } = await setup();
    const issued = unwrap(await issueKey(t.db, operator, agent.id, { scopes: ["read"] }, NOW));
    expectError(await revokeKeyCore(deps(operator, crossSite), issued.record.id), "origin_mismatch");
    expect(await count("api_keys where id = $1 and revoked_at is not null", [issued.record.id])).toBe(0);
  });

  it("asks a signed-out visitor to sign in", async () => {
    expectError(await revokeKeyCore(deps(null), "00000000-0000-0000-0000-000000000000"), "not_signed_in");
  });
});
