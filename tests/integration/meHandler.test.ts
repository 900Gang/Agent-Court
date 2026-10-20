import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operators, type Agent, type Operator } from "@/db/schema";
import { handleMe } from "@/lib/http/meHandler";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import { createAgent, setAgentStatus } from "@/lib/services/agentService";
import { issueKey, revokeKey } from "@/lib/services/keyService";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let counter = 0;
const uniq = (prefix: string) => `${prefix}-${++counter}`;
const DAY = 86_400_000;
// The agent is created at the real time; asking 30 days later makes it an established agent.
const now = new Date(Date.now() + 30 * DAY);

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

async function makeOperator(): Promise<Operator> {
  const [row] = await t.db
    .insert(operators)
    .values({ githubId: uniq("gh"), displayName: "Operator", status: "active" })
    .returning();
  return row;
}

async function setup(raw: Record<string, unknown> = {}) {
  const operator = await makeOperator();
  const agent: Agent = unwrap(await createAgent(t.db, operator, { handle: uniq("agent") }));
  const issued = unwrap(await issueKey(t.db, operator, agent.id, { scopes: ["read", "cases:write"], ...raw }));
  return { operator, agent, issued };
}

const limiter = () => createMemoryLimiter(() => now.getTime());
const request = (authorization?: string) =>
  new Request("http://localhost:3000/api/v1/me", authorization ? { headers: { authorization } } : undefined);
const call = (limiterInstance: ReturnType<typeof limiter>, authorization?: string) =>
  handleMe(request(authorization), { db: t.db, limiter: limiterInstance, now });

describe("GET /api/v1/me: success", () => {
  it("returns the agent, its scopes and its limits", async () => {
    const { agent, issued } = await setup();
    const response = await call(limiter(), `Bearer ${issued.key}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      agent: { id: agent.id, handle: agent.handle },
      scopes: ["read", "cases:write"],
      limits: { perKey: 60, perOperator: 120 },
    });
  });

  it("sends the rate-limit headers", async () => {
    const { issued } = await setup();
    const response = await call(limiter(), `Bearer ${issued.key}`);
    expect(response.headers.get("ratelimit-limit")).toBe("60");
    expect(response.headers.get("ratelimit-remaining")).toBe("59");
    expect(response.headers.get("ratelimit-reset")).toBe("60");
  });

  it("does not reveal the operator, the key id, the hash or the key", async () => {
    const { operator, issued } = await setup();
    const text = await (await call(limiter(), `Bearer ${issued.key}`)).text();
    expect(text).not.toContain(operator.id);
    expect(text).not.toContain(issued.record.id);
    expect(text).not.toContain(issued.key);
    expect(text).not.toContain(issued.key.slice(8));
  });
});

describe("GET /api/v1/me: authentication failures", () => {
  async function expectError(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["code", "hint", "message"]);
    expect(body.code).toBe(code);
  }

  it("answers 401 missing_key without a header and for a malformed one", async () => {
    await expectError(await call(limiter()), 401, "missing_key");
    await expectError(await call(limiter(), "Bearer nonsense"), 401, "missing_key");
    await expectError(await call(limiter(), "Basic abc"), 401, "missing_key");
  });

  it("answers 401 invalid_key for a well-formed key that was never issued", async () => {
    await expectError(await call(limiter(), `Bearer ac_live_${"A".repeat(32)}`), 401, "invalid_key");
  });

  it("answers 401 revoked_key", async () => {
    const { operator, issued } = await setup();
    unwrap(await revokeKey(t.db, operator, issued.record.id));
    await expectError(await call(limiter(), `Bearer ${issued.key}`), 401, "revoked_key");
  });

  it("answers 401 expired_key", async () => {
    const { issued } = await setup({ expiresInDays: 30 });
    const later = new Date(now.getTime() + 2 * DAY);
    const response = await handleMe(request(`Bearer ${issued.key}`), { db: t.db, limiter: limiter(), now: later });
    await expectError(response, 401, "expired_key");
  });

  it("answers 403 agent_inactive for a suspended agent", async () => {
    const { operator, agent, issued } = await setup();
    unwrap(await setAgentStatus(t.db, operator, agent.id, "suspended"));
    await expectError(await call(limiter(), `Bearer ${issued.key}`), 403, "agent_inactive");
  });

  it("answers 403 operator_inactive for a suspended operator", async () => {
    const { operator, issued } = await setup();
    await t.sql(`update operators set status = 'suspended' where id = $1`, [operator.id]);
    await expectError(await call(limiter(), `Bearer ${issued.key}`), 403, "operator_inactive");
  });

  it("sends WWW-Authenticate on 401 only", async () => {
    const { agent, operator, issued } = await setup();
    expect((await call(limiter(), undefined)).headers.get("www-authenticate")).toBe("Bearer");
    unwrap(await setAgentStatus(t.db, operator, agent.id, "suspended"));
    expect((await call(limiter(), `Bearer ${issued.key}`)).headers.get("www-authenticate")).toBeNull();
  });
});

describe("GET /api/v1/me: rate limiting", () => {
  it("allows 60 requests in a minute and answers 429 rate_limited on the 61st", async () => {
    const { issued } = await setup();
    const shared = limiter();
    for (let i = 0; i < 60; i++) {
      expect((await call(shared, `Bearer ${issued.key}`)).status).toBe(200);
    }
    const response = await call(shared, `Bearer ${issued.key}`);
    expect(response.status).toBe(429);
    expect((await response.json()).code).toBe("rate_limited");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(response.headers.get("ratelimit-limit")).toBe("60");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
  });

  it("does not spend rate limit on requests that fail authentication", async () => {
    const { issued } = await setup();
    const shared = limiter();
    for (let i = 0; i < 100; i++) await call(shared, `Bearer ac_live_${"B".repeat(32)}`);
    for (let i = 0; i < 60; i++) {
      expect((await call(shared, `Bearer ${issued.key}`)).status).toBe(200);
    }
  });
});
