import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { reputationEvents } from "@/db/schema";
import type { ApiScope } from "@/lib/config/constants";
import type { ApiDeps } from "@/lib/http/apiPipeline";
import { handleListCases } from "@/lib/http/handlers/cases";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import { issueKey } from "@/lib/services/keyService";
import { reverseForVerdict } from "@/lib/services/reputationService";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const DAY = 86_400_000;
// An established agent (created at the real time, asked 30 days later) has the base limit of 60 a minute.
const later = new Date(Date.now() + 30 * DAY);

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

afterEach(() => vi.restoreAllMocks());

const deps = (now: Date): ApiDeps => ({ db: t.db, limiter: createMemoryLimiter(() => now.getTime()), gate: passGate, writesEnabled: true, now });

async function agentWithKey(scopes: ApiScope[] = ["read"]) {
  const made = await f.makeAgent();
  const issued = f.unwrap(await issueKey(t.db, made.operator, made.agent.id, { scopes }));
  return { ...made, key: issued.key };
}

const list = (key: string | null) => new Request("http://localhost:3000/api/v1/cases", { headers: key ? { authorization: `Bearer ${key}` } : {} });
const limitOf = (response: Response) => Number(response.headers.get("ratelimit-limit"));

/** Gives `agent` one verdict's worth of an event, directly, with the given points and status. Returns the verdict id. */
async function plant(agent: Awaited<ReturnType<typeof f.makeAgent>>, points: number, status: "pending" | "final") {
  const issuer = await f.makeAgent();
  const c = await f.insertCase(issuer.actor.agentId, { status: "resolved" });
  const argument = await f.insertArgument(c.id, agent.actor.agentId, "won");
  const [{ id }] = await t.sql(
    `insert into verdicts (case_id, winning_argument_id, decided_by, decided_by_operator_id, verification_level, status)
     values ($1, $2, 'operator', $3, 'operator_confirmed', 'active') returning id`,
    [c.id, argument.id, issuer.actor.operatorId],
  );
  await t.db.insert(reputationEvents).values({ agentId: agent.actor.agentId, operatorId: agent.actor.operatorId, verdictId: id as string, points, reason: "verdict_win", status });
  return id as string;
}

describe("the rate limit follows the tier", () => {
  it.each([
    [0, 60],
    [29, 60],
    [30, 120],
    [99, 120],
    [100, 180],
    [299, 180],
    [300, 240],
  ])("gives an agent with %i final points a limit of %i a minute", async (points, limit) => {
    const agent = await agentWithKey();
    if (points > 0) await plant(agent, points, "final");
    expect(limitOf(await handleListCases(list(agent.key), deps(later)))).toBe(limit);
  });

  it("is not raised by pending points, however many", async () => {
    const agent = await agentWithKey();
    await plant(agent, 5000, "pending");
    expect(limitOf(await handleListCases(list(agent.key), deps(later)))).toBe(60);
  });

  it("falls at once on the next request when a verdict is reversed", async () => {
    const agent = await agentWithKey();
    const verdictId = await plant(agent, 30, "final");
    expect(limitOf(await handleListCases(list(agent.key), deps(later)))).toBe(120);
    await reverseForVerdict(t.db, verdictId);
    expect(limitOf(await handleListCases(list(agent.key), deps(later)))).toBe(60);
  });

  it("multiplies the lower limit of a new agent, and leaves other agents alone", async () => {
    const newcomer = await agentWithKey();
    const other = await agentWithKey();
    await plant(newcomer, 30, "final");
    const justCreated = new Date();
    expect(limitOf(await handleListCases(list(newcomer.key), deps(justCreated)))).toBe(60);
    expect(limitOf(await handleListCases(list(other.key), deps(justCreated)))).toBe(30);
  });

  it("answers 429 once the raised limit is used up, not before", async () => {
    const agent = await agentWithKey();
    await plant(agent, 30, "final");
    const shared = deps(later);
    for (let i = 0; i < 120; i++) expect((await handleListCases(list(agent.key), shared)).status, `request ${i + 1}`).toBe(200);
    expect((await handleListCases(list(agent.key), shared)).status).toBe(429);
  });

  it("counts a failed tier lookup as tier 0, so the request still goes through at the base limit", async () => {
    const agent = await agentWithKey();
    await plant(agent, 300, "final");
    const original = t.pg.query.bind(t.pg) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(t.pg, "query").mockImplementation(((sql: unknown, ...rest: unknown[]) =>
      String(sql).includes("reputation_events") ? Promise.reject(new Error("boom")) : original(sql, ...rest)) as never);
    const response = await handleListCases(list(agent.key), deps(later));
    expect(response.status).toBe(200);
    expect(limitOf(response)).toBe(60);
  });
});

describe("what a request costs", () => {
  const reputationStatements = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.filter((call: unknown[]) => String(call[0]).includes("reputation_events")).length;

  it("asks about reputation once for an authenticated request", async () => {
    const agent = await agentWithKey();
    const spy = vi.spyOn(t.pg, "query");
    expect((await handleListCases(list(agent.key), deps(later))).status).toBe(200);
    expect(reputationStatements(spy)).toBe(1);
  });

  it("does not ask for a request with no key, with an unknown key, or without the scope", async () => {
    const writer = await agentWithKey(["cases:write"]);
    const spy = vi.spyOn(t.pg, "query");
    expect((await handleListCases(list(null), deps(later))).status).toBe(401);
    expect((await handleListCases(list(`ac_live_${"A".repeat(32)}`), deps(later))).status).toBe(401);
    expect((await handleListCases(list(writer.key), deps(later))).status).toBe(403);
    expect(reputationStatements(spy)).toBe(0);
  });
});
