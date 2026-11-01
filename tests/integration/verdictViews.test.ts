import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reputationEvents } from "@/db/schema";
import type { ApiScope } from "@/lib/config/constants";
import type { ApiDeps } from "@/lib/http/apiPipeline";
import { handleFileCase, handleGetCase } from "@/lib/http/handlers/cases";
import { handleGetAgent } from "@/lib/http/handlers/agents";
import { handleMe } from "@/lib/http/meHandler";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import { issueKey } from "@/lib/services/keyService";
import { issueVerdict } from "@/lib/services/verdictService";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const DAY = 86_400_000;
const now = new Date(Date.now() + 30 * DAY);

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

const deps = (): ApiDeps => ({ db: t.db, limiter: createMemoryLimiter(() => now.getTime()), gate: passGate, writesEnabled: true, now });

async function agentWithKey(scopes: ApiScope[] = ["read", "cases:write"]) {
  const made = await f.makeAgent();
  const issued = f.unwrap(await issueKey(t.db, made.operator, made.agent.id, { scopes }));
  return { ...made, key: issued.key };
}

const get = (path: string, key: string) => new Request(`http://localhost:3000${path}`, { headers: { authorization: `Bearer ${key}` } });
const json = async (response: Response) => (await response.json()) as Json;

/** A case filed by one operator, argued by another agent, and resolved by a verdict with a note. */
async function resolvedCase(note?: string) {
  const filer = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { status: "open", title: "MARK_title" });
  const winner = await f.makeAgent();
  const argument = await f.insertArgument(c.id, winner.actor.agentId, "active");
  const issued = f.unwrap(await issueVerdict(t.db, passGate, filer.operator, { caseId: c.id, winningArgumentId: argument.id, note }, now));
  return { filer, c, winner, argument, verdictId: issued.verdictId };
}

function leaves(value: unknown, path: string[] = []): Array<{ path: string[]; value: unknown }> {
  if (Array.isArray(value)) return value.flatMap((item, i) => leaves(item, [...path, String(i)]));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
  return [{ path, value }];
}

async function plantEvent(agent: Awaited<ReturnType<typeof f.makeAgent>>, points: number, status: "pending" | "final" | "reversed") {
  const issuer = await f.makeAgent();
  const c = await f.insertCase(issuer.actor.agentId, { status: "resolved" });
  const argument = await f.insertArgument(c.id, agent.actor.agentId, "won");
  const [{ id }] = await t.sql(
    `insert into verdicts (case_id, winning_argument_id, decided_by, decided_by_operator_id, verification_level, status)
     values ($1, $2, 'operator', $3, 'operator_confirmed', 'active') returning id`,
    [c.id, argument.id, issuer.actor.operatorId],
  );
  await t.db.insert(reputationEvents).values({ agentId: agent.actor.agentId, operatorId: agent.actor.operatorId, verdictId: id as string, points, reason: "verdict_win", status });
}

describe("the case view carries the live verdict", () => {
  it("shows its status, level, who decided, the winner and the date, and the note only under untrusted_content", async () => {
    const reader = await agentWithKey();
    const r = await resolvedCase("MARK_note the cap fixed it");
    const response = await handleGetCase(get(`/api/v1/cases/${r.c.id}`, reader.key), deps(), { id: r.c.id });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.case.status).toBe("resolved");
    expect(body.case.verdict).toEqual({
      id: r.verdictId,
      status: "active",
      verification_level: "operator_confirmed",
      decided_by: "operator",
      winning_argument_id: r.argument.id,
      created_at: now.toISOString(),
      untrusted_content: { note: "MARK_note the cap fixed it" },
    });
    expect(typeof body.notice).toBe("string");
    for (const leaf of leaves(body)) {
      if (typeof leaf.value === "string" && leaf.value.includes("MARK_")) expect(leaf.path, leaf.path.join(".")).toContain("untrusted_content");
    }
  });

  it("has a null note when there is none, and a verdict of null when there is no verdict", async () => {
    const reader = await agentWithKey();
    const r = await resolvedCase();
    expect((await json(await handleGetCase(get(`/api/v1/cases/${r.c.id}`, reader.key), deps(), { id: r.c.id }))).case.verdict.untrusted_content).toEqual({ note: null });
    const open = await f.insertCase((await f.makeAgent()).actor.agentId, { status: "open" });
    expect((await json(await handleGetCase(get(`/api/v1/cases/${open.id}`, reader.key), deps(), { id: open.id }))).case.verdict).toBeNull();
  });

  it("shows a verdict under appeal as such, and an overturned verdict not at all", async () => {
    const reader = await agentWithKey();
    const r = await resolvedCase();
    await t.sql(`update verdicts set status = 'under_appeal' where id = $1`, [r.verdictId]);
    expect((await json(await handleGetCase(get(`/api/v1/cases/${r.c.id}`, reader.key), deps(), { id: r.c.id }))).case.verdict.status).toBe("under_appeal");
    await t.sql(`update verdicts set status = 'overturned' where id = $1`, [r.verdictId]);
    expect((await json(await handleGetCase(get(`/api/v1/cases/${r.c.id}`, reader.key), deps(), { id: r.c.id }))).case.verdict).toBeNull();
  });

  it("holds no operator id, no email and no reputation detail", async () => {
    const reader = await agentWithKey();
    const r = await resolvedCase("A note.");
    const text = await (await handleGetCase(get(`/api/v1/cases/${r.c.id}`, reader.key), deps(), { id: r.c.id })).text();
    for (const secret of [r.filer.operator.id, r.winner.operator.id, "decided_by_operator", "reputation"]) expect(text, secret).not.toContain(secret);
  });

  it("is in the answer to filing a case too, as null for a new case", async () => {
    const filer = await agentWithKey(["read", "cases:write"]);
    const response = await handleFileCase(
      new Request("http://localhost:3000/api/v1/cases", {
        method: "POST",
        headers: { authorization: `Bearer ${filer.key}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "T", summary: "S", expected: "E", actual: "A", tags: [], environment: {}, evidence: [] }),
      }),
      deps(),
    );
    expect(response.status).toBe(201);
    expect((await json(response)).case.verdict).toBeNull();
  });
});

describe("the agent view carries reputation", () => {
  it("shows final points and the tier, and never pending points", async () => {
    const reader = await agentWithKey();
    const winner = await f.makeAgent();
    await plantEvent(winner, 30, "final");
    await plantEvent(winner, 500, "pending");
    await plantEvent(winner, 100, "reversed");
    const body = await json(await handleGetAgent(get(`/api/v1/agents/${winner.agent.handle}`, reader.key), deps(), { handle: winner.agent.handle }));
    expect(body.agent.reputation).toEqual({ points: 30, tier: 1 });
    expect(JSON.stringify(body)).not.toContain("pending");
    expect(JSON.stringify(body)).not.toContain("500");
  });

  it("is points 0 and tier 0 for an agent with no events", async () => {
    const reader = await agentWithKey();
    const fresh = await f.makeAgent();
    const body = await json(await handleGetAgent(get(`/api/v1/agents/${fresh.agent.handle}`, reader.key), deps(), { handle: fresh.agent.handle }));
    expect(body.agent.reputation).toEqual({ points: 0, tier: 0 });
  });

  it("gives an agent its own pending points on /me, and its limits at its tier", async () => {
    const own = await agentWithKey();
    await plantEvent(own, 100, "final");
    await plantEvent(own, 40, "pending");
    const response = await handleMe(get("/api/v1/me", own.key), { db: t.db, limiter: createMemoryLimiter(() => now.getTime()), now });
    const body = await json(response);
    expect(body.reputation).toEqual({ points: 100, pending: 40, tier: 2 });
    expect(body.limits).toEqual({ perKey: 180, perOperator: 360 });
    expect(response.headers.get("ratelimit-limit")).toBe("180");
  });
});
