import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operators, reputationEvents, type Operator } from "@/db/schema";
import { moderateCore } from "@/lib/admin/actionsCore";
import { issueKeyCore, registerAgentCore, revokeKeyCore, setAgentStatusCore, type ActionDeps } from "@/lib/dashboard/actionsCore";
import { issueVerdictCore } from "@/lib/dashboard/verdictCore";
import type { ApiScope } from "@/lib/config/constants";
import type { ApiDeps } from "@/lib/http/apiPipeline";
import { handleGetAgent } from "@/lib/http/handlers/agents";
import { handleSubmitArgument, handleWithdrawArgument } from "@/lib/http/handlers/arguments";
import { handleAddEvidence, handleFileCase, handleGetCase, handleListCases, handleSearchCases, handleWithdrawCase } from "@/lib/http/handlers/cases";
import { handleMe } from "@/lib/http/meHandler";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import { createReportCore } from "@/lib/observer/actionsCore";
import { issueKey } from "@/lib/services/keyService";
import { getPublicAgentView, getPublicCaseView, listHomeCases } from "@/lib/services/observerService";
import { getReputation } from "@/lib/services/reputationService";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

// AC-812: points come from a verdict and from nothing else. Whatever an agent, an operator, an administrator or a
// visitor does, the table of reputation events stays exactly as it was. The one control is a verdict, which must change it.

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORIGIN = "http://localhost:3000";

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

/** Every row of the table, in a fixed order. Equal text means nothing was added, changed or removed. */
async function snapshot(): Promise<string> {
  const rows = await t.sql(
    `select id, agent_id, operator_id, verdict_id, points, reason, status, release_at from reputation_events order by id`,
  );
  return JSON.stringify(rows);
}

async function leavesReputationAlone(act: () => Promise<void>) {
  const before = await snapshot();
  await act();
  expect(await snapshot()).toBe(before);
}

type Made = Awaited<ReturnType<ReturnType<typeof createFixtures>["makeAgent"]>>;

async function plant(agent: Made, points: number, status: "pending" | "final") {
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

const apiDeps = (): ApiDeps => ({ db: t.db, limiter: createMemoryLimiter(), gate: passGate, writesEnabled: true });

async function agentWithKey(scopes: ApiScope[] = ["read", "cases:write", "arguments:write"]) {
  const made = await f.makeAgent();
  const issued = f.unwrap(await issueKey(t.db, made.operator, made.agent.id, { scopes }));
  return { ...made, key: issued.key };
}

function req(method: string, path: string, key: string, body?: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const dashDeps = (operator: Operator | null): ActionDeps => ({
  db: t.db,
  operator,
  headers: new Headers({ origin: ORIGIN }),
  expectedOrigin: ORIGIN,
});

function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) for (const item of Array.isArray(value) ? value : [value]) data.append(name, item);
  return data;
}

/** A agent that already has final and pending points, to act on and around. */
async function agentWithPoints() {
  const rich = await agentWithKey();
  await plant(rich, 30, "final");
  await plant(rich, 10, "pending");
  return rich;
}

describe("agent actions through the API", () => {
  it("filing a case, adding evidence, reading, listing, searching and withdrawing it", async () => {
    const rich = await agentWithPoints();
    await leavesReputationAlone(async () => {
      const filed = await handleFileCase(
        req("POST", "/api/v1/cases", rich.key, { title: "T", summary: "S", expected: "E", actual: "A", tags: [], environment: {}, evidence: [] }),
        apiDeps(),
      );
      expect(filed.status).toBe(201);
      const id = ((await filed.json()) as Json).case.id as string;
      expect((await handleAddEvidence(req("POST", `/api/v1/cases/${id}/evidence`, rich.key, { kind: "error", text: "boom" }), apiDeps(), { id })).status).toBe(201);
      expect((await handleGetCase(req("GET", `/api/v1/cases/${id}`, rich.key), apiDeps(), { id })).status).toBe(200);
      expect((await handleListCases(req("GET", "/api/v1/cases", rich.key), apiDeps())).status).toBe(200);
      await handleSearchCases(req("GET", "/api/v1/cases/search?q=retry", rich.key), apiDeps());
      expect((await handleWithdrawCase(req("POST", `/api/v1/cases/${id}/withdraw`, rich.key, {}), apiDeps(), { id })).status).toBe(200);
    });
  });

  it("submitting and withdrawing arguments, by several agents on one case", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const rich = await agentWithPoints();
    const other = await agentWithKey();
    await leavesReputationAlone(async () => {
      for (const who of [rich, other]) {
        const made = await handleSubmitArgument(
          req("POST", `/api/v1/cases/${c.id}/arguments`, who.key, { reasoning: "It has no exit.", proposed_change: "Add one." }),
          apiDeps(),
          { id: c.id },
        );
        expect(made.status).toBe(201);
        const argumentId = ((await made.json()) as Json).argument.id as string;
        const withdrawn = await handleWithdrawArgument(req("POST", `/api/v1/arguments/${argumentId}/withdraw`, who.key, {}), apiDeps(), { id: argumentId });
        expect(withdrawn.status).toBe(200);
      }
    });
  });

  it("reading an agent's profile and its own /me", async () => {
    const rich = await agentWithPoints();
    await leavesReputationAlone(async () => {
      expect((await handleGetAgent(req("GET", `/api/v1/agents/${rich.agent.handle}`, rich.key), apiDeps(), { handle: rich.agent.handle })).status).toBe(200);
      expect((await handleMe(req("GET", "/api/v1/me", rich.key), { db: t.db, limiter: createMemoryLimiter() })).status).toBe(200);
    });
  });
});

describe("operator actions on the dashboard", () => {
  it("registering an agent, issuing and revoking a key, suspending and reactivating", async () => {
    const operator = await f.makeOperator();
    await leavesReputationAlone(async () => {
      const registered = await registerAgentCore(dashDeps(operator), form({ handle: f.uniq("agent") }));
      expect(registered.ok).toBe(true);
      if (!registered.ok) return;
      const key = await issueKeyCore(dashDeps(operator), registered.value.agentId, form({ scopes: ["read"] }));
      expect(key.ok).toBe(true);
      if (key.ok) expect((await revokeKeyCore(dashDeps(operator), key.value.keyId)).ok).toBe(true);
      expect((await setAgentStatusCore(dashDeps(operator), registered.value.agentId, "suspended")).ok).toBe(true);
      expect((await setAgentStatusCore(dashDeps(operator), registered.value.agentId, "active")).ok).toBe(true);
    });
  });

  it("suspending the agent that has the points, and reporting its case and its argument", async () => {
    const rich = await agentWithPoints();
    const c = await f.insertCase(rich.actor.agentId, { status: "open" });
    const rival = await f.makeAgent();
    const argument = await f.insertArgument(c.id, rival.actor.agentId, "active");
    const reporter = await f.makeOperator();
    await leavesReputationAlone(async () => {
      const reason = "This reads like an instruction to the next reader, not a report.";
      expect((await createReportCore(dashDeps(reporter), form({ targetType: "case", targetId: c.id, reason }))).ok).toBe(true);
      expect((await createReportCore(dashDeps(reporter), form({ targetType: "argument", targetId: argument.id, reason }))).ok).toBe(true);
      expect((await setAgentStatusCore(dashDeps(rich.operator), rich.agent.id, "suspended")).ok).toBe(true);
    });
    expect(await getReputation(t.db, rich.agent.id)).toMatchObject({ points: 30, pending: 10 });
  });
});

describe("administrator actions", () => {
  it("approving and rejecting held cases, evidence and arguments", async () => {
    const [admin] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Admin", role: "admin", status: "active" }).returning();
    const rich = await agentWithPoints();
    const heldCase = await f.insertCase(rich.actor.agentId, { status: "held" });
    const toReject = await f.insertCase(rich.actor.agentId, { status: "held" });
    const openCase = await f.insertCase(rich.actor.agentId, { status: "open" });
    const rival = await f.makeAgent();
    const heldArgument = await f.insertArgument(openCase.id, rival.actor.agentId, "held");
    await leavesReputationAlone(async () => {
      expect((await moderateCore(dashDeps(admin), { kind: "case", id: heldCase.id, decision: "approve" })).ok).toBe(true);
      expect((await moderateCore(dashDeps(admin), { kind: "case", id: toReject.id, decision: "reject" })).ok).toBe(true);
      expect((await moderateCore(dashDeps(admin), { kind: "argument", id: heldArgument.id, decision: "approve" })).ok).toBe(true);
    });
  });
});

describe("what a visitor reads", () => {
  it("the public case page, the public profile and the home lists", async () => {
    const rich = await agentWithPoints();
    const c = await f.insertCase(rich.actor.agentId, { status: "open" });
    await leavesReputationAlone(async () => {
      expect(await getPublicCaseView(t.db, c.id)).not.toBeNull();
      expect(await getPublicAgentView(t.db, rich.agent.handle)).not.toBeNull();
      await listHomeCases(t.db);
    });
  });
});

describe("the control: a verdict is the one thing that does add points", () => {
  it("adds exactly one pending event for the winner and changes no other row", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const rival = await f.makeAgent();
    const argument = await f.insertArgument(c.id, rival.actor.agentId, "active");
    const before = JSON.parse(await snapshot()) as unknown[];
    const result = await issueVerdictCore(dashDeps(filer.operator), form({ caseId: c.id, winningArgumentId: argument.id }));
    expect(result.ok).toBe(true);
    const after = JSON.parse(await snapshot()) as Array<{ agent_id: string; status: string }>;
    expect(after).toHaveLength(before.length + 1);
    expect(after.filter((row) => !JSON.stringify(before).includes(JSON.stringify(row)))).toEqual([
      expect.objectContaining({ agent_id: rival.actor.agentId, status: "pending" }),
    ]);
  });
});
