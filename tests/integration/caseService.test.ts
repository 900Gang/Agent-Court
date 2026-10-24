import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  argumentsTable,
  cases,
  evidence as evidenceTable,
  operators,
  type Agent,
  type Case,
  type NewCase,
} from "@/db/schema";
import { failClosedGate } from "@/lib/safety/stub";
import type { GateInput, SafetyGate } from "@/lib/safety/gate";
import { decodeCursor, type ListQuery } from "@/lib/schemas/pagination";
import { createAgent, getAgentByHandle } from "@/lib/services/agentService";
import {
  addEvidence,
  fileCase,
  getCase,
  listCases,
  publishHeldCase,
  publishHeldEvidence,
  withdrawCase,
} from "@/lib/services/caseService";
import { eq } from "drizzle-orm";
import { blockGate, passGate, throwingGate } from "../helpers/gates";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let counter = 0;
const uniq = (prefix: string) => `${prefix}-${++counter}`;
const NOW = new Date("2026-10-20T12:00:00.000Z");

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

function errorOf(result: { ok: boolean; error?: string }): string {
  if (result.ok) throw new Error("expected a failure");
  return result.error ?? "";
}

async function makeAgent(): Promise<{ agent: Agent; actor: { agentId: string; operatorId: string } }> {
  const [operator] = await t.db
    .insert(operators)
    .values({ githubId: uniq("gh"), displayName: "Operator", status: "active" })
    .returning();
  const agent = unwrap(await createAgent(t.db, operator, { handle: uniq("agent") }));
  return { agent, actor: { agentId: agent.id, operatorId: operator.id } };
}

async function insertCase(agentId: string, over: Partial<NewCase> = {}): Promise<Case> {
  const [row] = await t.db
    .insert(cases)
    .values({ agentId, title: "T", summary: "S", expected: "E", actual: "A", ...over })
    .returning();
  return row;
}

async function insertEvidence(caseId: string, status: "held" | "active") {
  const [row] = await t.db.insert(evidenceTable).values({ caseId, kind: "trace", redactedText: "x", status }).returning();
  return row;
}

async function insertArgument(
  caseId: string,
  agentId: string,
  status: "held" | "active" | "withdrawn" | "won",
  createdAt?: Date,
) {
  const [row] = await t.db
    .insert(argumentsTable)
    .values({ caseId, agentId, reasoning: "r", proposedChange: "p", status, ...(createdAt ? { createdAt } : {}) })
    .returning();
  return row;
}

async function count(query: string, params: unknown[] = []): Promise<number> {
  const rows = await t.sql(`select count(*)::int as n from ${query}`, params);
  return rows[0].n as number;
}

const validCase = {
  title: "Tool call loops",
  summary: "The agent repeats a call.",
  expected: "One call.",
  actual: "Ten calls.",
  tags: ["tool-call"],
  environment: { model: "model-a" },
  evidence: [{ kind: "trace", text: "step 1" }],
};

function spyGate(): { gate: SafetyGate; calls: GateInput[] } {
  const calls: GateInput[] = [];
  return {
    calls,
    gate: {
      screen: async (input) => {
        calls.push(input);
        return passGate.screen(input);
      },
    },
  };
}

const query = (over: Partial<ListQuery> = {}): ListQuery => ({
  limit: 20,
  cursor: null,
  status: null,
  tag: null,
  needsArguments: false,
  ...over,
});

describe("fileCase", () => {
  it("publishes the case and its evidence when the gate passes", async () => {
    const { actor } = await makeAgent();
    const result = unwrap(await fileCase(t.db, passGate, actor, validCase, NOW));
    expect(result.held).toBe(false);
    expect(result.case).toMatchObject({ status: "open", agentId: actor.agentId, tags: ["tool-call"], environment: { model: "model-a" } });
    expect(result.case.publishedAt).toEqual(NOW);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ status: "active", kind: "trace", redactedText: "step 1" });
  });

  it("holds the case and its evidence when the gate flags, and publishes nothing", async () => {
    const { actor } = await makeAgent();
    const result = unwrap(await fileCase(t.db, failClosedGate, actor, validCase, NOW));
    expect(result.held).toBe(true);
    expect(result.case.status).toBe("held");
    expect(result.case.publishedAt).toBeNull();
    expect(result.evidence[0].status).toBe("held");
  });

  it("holds the case when the gate throws", async () => {
    const { actor } = await makeAgent();
    const result = unwrap(await fileCase(t.db, throwingGate, actor, validCase, NOW));
    expect(result.held).toBe(true);
    expect(result.case.status).toBe("held");
  });

  it("stores nothing but a moderation event when the gate blocks", async () => {
    const { actor } = await makeAgent();
    const before = await count("moderation_events where target_type = 'case' and target_id is null and result = 'block'");
    expect(errorOf(await fileCase(t.db, blockGate, actor, validCase, NOW))).toBe("blocked");
    expect(await count("cases where agent_id = $1", [actor.agentId])).toBe(0);
    expect(await count("evidence where case_id in (select id from cases where agent_id = $1)", [actor.agentId])).toBe(0);
    expect(await count("moderation_events where target_type = 'case' and target_id is null and result = 'block'")).toBe(before + 1);
    expect(await count("audit_log where actor_id = $1 and action = 'case.filed'", [actor.agentId])).toBe(0);
  });

  it("stores the text the gate returns, not the text it was given", async () => {
    const { actor } = await makeAgent();
    const shouting: SafetyGate = {
      screen: async (input) => ({
        outcome: "pass",
        fields: Object.fromEntries(Object.entries(input.fields).map(([key, value]) => [key, value.toUpperCase()])),
        report: {},
      }),
    };
    const result = unwrap(await fileCase(t.db, shouting, actor, validCase, NOW));
    expect(result.case.title).toBe("TOOL CALL LOOPS");
    expect(result.case.actual).toBe("TEN CALLS.");
    expect(result.evidence[0].redactedText).toBe("STEP 1");
  });

  it("rejects invalid input without calling the gate or writing rows", async () => {
    const { actor } = await makeAgent();
    const { gate, calls } = spyGate();
    const result = await fileCase(t.db, gate, actor, { ...validCase, title: "" }, NOW);
    expect(errorOf(result)).toBe("invalid");
    expect(!result.ok && result.detail).toHaveProperty("title");
    expect(calls).toHaveLength(0);
    expect(await count("cases where agent_id = $1", [actor.agentId])).toBe(0);
  });

  it("writes one moderation event per decision and an audit row with ids only", async () => {
    const { actor } = await makeAgent();
    const result = unwrap(await fileCase(t.db, passGate, actor, validCase, NOW));
    expect(await count("moderation_events where target_id = $1 and result = 'pass'", [result.case.id])).toBe(1);
    expect(await count("moderation_events where target_id = $1 and result = 'pass'", [result.evidence[0].id])).toBe(1);
    const rows = await t.sql(
      `select action, actor_type, actor_id, metadata::text as text from audit_log where target = $1`,
      [result.case.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "case.filed", actor_type: "agent", actor_id: actor.agentId });
    expect(rows[0].text).not.toContain("Tool call loops");
  });
});

describe("addEvidence", () => {
  const evidenceInput = { kind: "error", text: "boom" };

  it("adds active evidence to an open case when the gate passes", async () => {
    const { actor } = await makeAgent();
    const c = await insertCase(actor.agentId, { status: "open" });
    const result = unwrap(await addEvidence(t.db, passGate, actor, c.id, evidenceInput));
    expect(result.held).toBe(false);
    expect(result.evidence).toMatchObject({ caseId: c.id, kind: "error", redactedText: "boom", status: "active" });
    const rows = await t.sql(`select action, actor_type from audit_log where target = $1`, [result.evidence.id]);
    expect(rows).toEqual([{ action: "evidence.added", actor_type: "agent" }]);
  });

  it("holds evidence the gate flags", async () => {
    const { actor } = await makeAgent();
    const c = await insertCase(actor.agentId, { status: "open" });
    const result = unwrap(await addEvidence(t.db, failClosedGate, actor, c.id, evidenceInput));
    expect(result.held).toBe(true);
    expect(result.evidence.status).toBe("held");
  });

  it("keeps evidence held on a held case, whatever the gate says", async () => {
    const { actor } = await makeAgent();
    const c = await insertCase(actor.agentId, { status: "held" });
    const result = unwrap(await addEvidence(t.db, passGate, actor, c.id, evidenceInput));
    expect(result.evidence.status).toBe("held");
    expect(result.held).toBe(true);
  });

  it("accepts evidence on an argued case", async () => {
    const { actor } = await makeAgent();
    const c = await insertCase(actor.agentId, { status: "argued" });
    expect(unwrap(await addEvidence(t.db, passGate, actor, c.id, evidenceInput)).held).toBe(false);
  });

  it("answers not_found to another agent, even for a public case", async () => {
    const { actor } = await makeAgent();
    const other = await makeAgent();
    const c = await insertCase(actor.agentId, { status: "open" });
    expect(errorOf(await addEvidence(t.db, passGate, other.actor, c.id, evidenceInput))).toBe("not_found");
  });

  it.each(["withdrawn", "resolved", "closed_unresolved", "under_appeal"] as const)(
    "refuses evidence on a %s case",
    async (status) => {
      const { actor } = await makeAgent();
      const c = await insertCase(actor.agentId, { status });
      expect(errorOf(await addEvidence(t.db, passGate, actor, c.id, evidenceInput))).toBe("illegal_transition");
    },
  );

  it("refuses an eleventh evidence item, counting held items too", async () => {
    const { actor } = await makeAgent();
    const c = await insertCase(actor.agentId, { status: "open" });
    for (let i = 0; i < 5; i++) await insertEvidence(c.id, "active");
    for (let i = 0; i < 5; i++) await insertEvidence(c.id, "held");
    expect(errorOf(await addEvidence(t.db, passGate, actor, c.id, evidenceInput))).toBe("limit_reached");
  });

  it("answers not_found for ids that are not UUIDs, without calling the gate", async () => {
    const { actor } = await makeAgent();
    const { gate, calls } = spyGate();
    for (const id of ["not-a-uuid", "", "%00", crypto.randomUUID()]) {
      expect(errorOf(await addEvidence(t.db, gate, actor, id, evidenceInput))).toBe("not_found");
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects invalid input", async () => {
    const { actor } = await makeAgent();
    const c = await insertCase(actor.agentId, { status: "open" });
    expect(errorOf(await addEvidence(t.db, passGate, actor, c.id, { kind: "log", text: "x" }))).toBe("invalid");
  });

  it("stores nothing but a moderation event when the gate blocks", async () => {
    const { actor } = await makeAgent();
    const c = await insertCase(actor.agentId, { status: "open" });
    const before = await count("moderation_events where target_type = 'evidence' and target_id is null and result = 'block'");
    expect(errorOf(await addEvidence(t.db, blockGate, actor, c.id, evidenceInput))).toBe("blocked");
    expect(await count("evidence where case_id = $1", [c.id])).toBe(0);
    expect(await count("moderation_events where target_type = 'evidence' and target_id is null and result = 'block'")).toBe(before + 1);
  });
});

describe("withdrawCase", () => {
  it.each(["open", "argued"] as const)("withdraws an own %s case", async (status) => {
    const { actor } = await makeAgent();
    const c = await insertCase(actor.agentId, { status });
    expect(unwrap(await withdrawCase(t.db, actor, c.id)).status).toBe("withdrawn");
    expect(await count("audit_log where target = $1 and action = 'case.withdrawn'", [c.id])).toBe(1);
  });

  it.each(["held", "resolved", "under_appeal", "closed_unresolved", "withdrawn"] as const)(
    "refuses to withdraw a %s case",
    async (status) => {
      const { actor } = await makeAgent();
      const c = await insertCase(actor.agentId, { status });
      expect(errorOf(await withdrawCase(t.db, actor, c.id))).toBe("illegal_transition");
    },
  );

  it("answers not_found to another agent and for ids that are not UUIDs", async () => {
    const { actor } = await makeAgent();
    const other = await makeAgent();
    const c = await insertCase(actor.agentId, { status: "open" });
    expect(errorOf(await withdrawCase(t.db, other.actor, c.id))).toBe("not_found");
    expect(errorOf(await withdrawCase(t.db, actor, "not-a-uuid"))).toBe("not_found");
    expect((await t.db.select().from(cases).where(eq(cases.id, c.id)))[0].status).toBe("open");
  });
});

describe("publishHeldCase and publishHeldEvidence", () => {
  it("opens a held case, sets published_at and activates its held evidence", async () => {
    const { actor } = await makeAgent();
    const c = await insertCase(actor.agentId, { status: "held" });
    const e = await insertEvidence(c.id, "held");
    const published = unwrap(await publishHeldCase(t.db, c.id));
    expect(published.status).toBe("open");
    expect(published.publishedAt).toBeInstanceOf(Date);
    const [row] = await t.db.select().from(evidenceTable).where(eq(evidenceTable.id, e.id));
    expect(row.status).toBe("active");
  });

  it("refuses a case that is not held, and answers not_found for unknown ids", async () => {
    const { actor } = await makeAgent();
    const c = await insertCase(actor.agentId, { status: "open" });
    expect(errorOf(await publishHeldCase(t.db, c.id))).toBe("illegal_transition");
    expect(errorOf(await publishHeldCase(t.db, crypto.randomUUID()))).toBe("not_found");
    expect(errorOf(await publishHeldCase(t.db, "not-a-uuid"))).toBe("not_found");
  });

  it("activates held evidence on a published case", async () => {
    const { actor } = await makeAgent();
    const c = await insertCase(actor.agentId, { status: "open" });
    const e = await insertEvidence(c.id, "held");
    expect(unwrap(await publishHeldEvidence(t.db, e.id)).status).toBe("active");
  });

  it("refuses evidence that is already active, or sits on a held case", async () => {
    const { actor } = await makeAgent();
    const open = await insertCase(actor.agentId, { status: "open" });
    const held = await insertCase(actor.agentId, { status: "held" });
    const active = await insertEvidence(open.id, "active");
    const onHeld = await insertEvidence(held.id, "held");
    expect(errorOf(await publishHeldEvidence(t.db, active.id))).toBe("illegal_transition");
    expect(errorOf(await publishHeldEvidence(t.db, onHeld.id))).toBe("illegal_transition");
    expect(errorOf(await publishHeldEvidence(t.db, crypto.randomUUID()))).toBe("not_found");
    expect(errorOf(await publishHeldEvidence(t.db, "not-a-uuid"))).toBe("not_found");
  });
});

describe("getCase", () => {
  it("returns an open case to another agent with the filer handle", async () => {
    const { agent, actor } = await makeAgent();
    const viewer = await makeAgent();
    const c = await insertCase(actor.agentId, { status: "open" });
    const detail = await getCase(t.db, viewer.actor.agentId, c.id);
    expect(detail?.case.id).toBe(c.id);
    expect(detail?.filedBy).toEqual({ handle: agent.handle });
  });

  it.each([
    ["held", true],
    ["withdrawn", true],
    ["rejected", false],
  ] as const)("shows a %s case to the filer: %s, and never to another agent", async (status, filerSees) => {
    const { actor } = await makeAgent();
    const other = await makeAgent();
    const c = await insertCase(actor.agentId, { status });
    expect((await getCase(t.db, actor.agentId, c.id)) !== null).toBe(filerSees);
    expect(await getCase(t.db, other.actor.agentId, c.id)).toBeNull();
  });

  it("returns null for ids that are not UUIDs and for unknown ids", async () => {
    const { actor } = await makeAgent();
    expect(await getCase(t.db, actor.agentId, "not-a-uuid")).toBeNull();
    expect(await getCase(t.db, actor.agentId, crypto.randomUUID())).toBeNull();
  });

  it("hides held evidence from other agents but shows it to the filer", async () => {
    const { actor } = await makeAgent();
    const other = await makeAgent();
    const c = await insertCase(actor.agentId, { status: "open" });
    await insertEvidence(c.id, "active");
    await insertEvidence(c.id, "held");
    expect((await getCase(t.db, other.actor.agentId, c.id))?.evidence.map((e) => e.status)).toEqual(["active"]);
    expect((await getCase(t.db, actor.agentId, c.id))?.evidence).toHaveLength(2);
  });

  it("shows arguments by their own visibility, oldest first, with author handles", async () => {
    const filer = await makeAgent();
    const a = await makeAgent();
    const b = await makeAgent();
    const d = await makeAgent();
    const viewer = await makeAgent();
    const c = await insertCase(filer.actor.agentId, { status: "argued" });
    const first = await insertArgument(c.id, a.actor.agentId, "active", new Date("2026-10-20T10:00:00Z"));
    await insertArgument(c.id, b.actor.agentId, "held", new Date("2026-10-20T11:00:00Z"));
    await insertArgument(c.id, d.actor.agentId, "withdrawn", new Date("2026-10-20T12:00:00Z"));

    const seen = await getCase(t.db, viewer.actor.agentId, c.id);
    expect(seen?.arguments.map((entry) => entry.argument.id)).toEqual([first.id]);
    expect(seen?.arguments[0].authorHandle).toBe(a.agent.handle);

    const heldAuthor = await getCase(t.db, b.actor.agentId, c.id);
    expect(heldAuthor?.arguments.map((entry) => entry.argument.status)).toEqual(["active", "held"]);
  });
});

describe("listCases", () => {
  it("pages through 45 cases in newest-first order without gaps or repeats", async () => {
    const { actor } = await makeAgent();
    const viewer = await makeAgent();
    const tag = "page-test";
    for (let i = 0; i < 45; i++) {
      await insertCase(actor.agentId, { status: "open", tags: [tag], createdAt: new Date(NOW.getTime() - i * 60_000) });
    }
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const result = await listCases(t.db, viewer.actor.agentId, query({ tag, limit: 20, cursor: cursor ? decodeCursor(cursor) : null }));
      sizes.push(result.items.length);
      seen.push(...result.items.map((item) => item.case.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(sizes).toEqual([20, 20, 5]);
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(45);
    const rows = await t.db.select().from(cases).where(eq(cases.agentId, actor.agentId));
    const expected = [...rows].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime()).map((row) => row.id);
    expect(seen).toEqual(expected);
  });

  it("breaks ties between equal timestamps by id, so paging never repeats or skips", async () => {
    const { actor } = await makeAgent();
    const tag = "tie-test";
    for (let i = 0; i < 3; i++) await insertCase(actor.agentId, { status: "open", tags: [tag], createdAt: NOW });
    const first = await listCases(t.db, actor.agentId, query({ tag, limit: 2 }));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listCases(t.db, actor.agentId, query({ tag, limit: 2, cursor: decodeCursor(first.nextCursor!) }));
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((item) => item.case.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("filters by tag and by status", async () => {
    const { actor } = await makeAgent();
    await insertCase(actor.agentId, { status: "open", tags: ["filter-a"] });
    await insertCase(actor.agentId, { status: "resolved", tags: ["filter-a"] });
    await insertCase(actor.agentId, { status: "open", tags: ["filter-b"] });
    const byTag = await listCases(t.db, actor.agentId, query({ tag: "filter-a" }));
    expect(byTag.items.map((item) => item.case.status).sort()).toEqual(["open", "resolved"]);
    const byStatus = await listCases(t.db, actor.agentId, query({ tag: "filter-a", status: "resolved" }));
    expect(byStatus.items.map((item) => item.case.status)).toEqual(["resolved"]);
  });

  it("never lists held, withdrawn or rejected cases, not even the filer's own", async () => {
    const { actor } = await makeAgent();
    const tag = "hidden-test";
    for (const status of ["held", "withdrawn", "rejected"] as const) {
      await insertCase(actor.agentId, { status, tags: [tag] });
    }
    const visible = await insertCase(actor.agentId, { status: "open", tags: [tag] });
    const result = await listCases(t.db, actor.agentId, query({ tag }));
    expect(result.items.map((item) => item.case.id)).toEqual([visible.id]);
  });

  it("lists only open cases from other agents when needs_arguments is set", async () => {
    const mine = await makeAgent();
    const theirs = await makeAgent();
    const tag = "needs-test";
    await insertCase(mine.actor.agentId, { status: "open", tags: [tag] });
    await insertCase(theirs.actor.agentId, { status: "argued", tags: [tag] });
    await insertCase(theirs.actor.agentId, { status: "resolved", tags: [tag] });
    const wanted = await insertCase(theirs.actor.agentId, { status: "open", tags: [tag] });
    const result = await listCases(t.db, mine.actor.agentId, query({ tag, needsArguments: true }));
    expect(result.items.map((item) => item.case.id)).toEqual([wanted.id]);
  });

  it("counts only visible active and won arguments, and names the filer", async () => {
    const filer = await makeAgent();
    const tag = "count-test";
    const c = await insertCase(filer.actor.agentId, { status: "argued", tags: [tag] });
    for (const status of ["active", "won", "held", "withdrawn"] as const) {
      await insertArgument(c.id, (await makeAgent()).actor.agentId, status);
    }
    const [item] = (await listCases(t.db, filer.actor.agentId, query({ tag }))).items;
    expect(item.argumentCount).toBe(2);
    expect(item.filedBy).toEqual({ handle: filer.agent.handle });
  });

  it("returns an empty page with no cursor when nothing matches", async () => {
    const { actor } = await makeAgent();
    expect(await listCases(t.db, actor.agentId, query({ tag: "no-such-tag" }))).toEqual({ items: [], nextCursor: null });
  });
});

describe("getAgentByHandle", () => {
  it("finds an agent by its exact handle", async () => {
    const { agent } = await makeAgent();
    expect((await getAgentByHandle(t.db, agent.handle))?.id).toBe(agent.id);
  });

  it("returns null for unknown handles, other letter case and soft-deleted agents", async () => {
    const { agent } = await makeAgent();
    expect(await getAgentByHandle(t.db, "no-such-agent")).toBeNull();
    expect(await getAgentByHandle(t.db, agent.handle.toUpperCase())).toBeNull();
    await t.db.update(agents).set({ deletedAt: NOW }).where(eq(agents.id, agent.id));
    expect(await getAgentByHandle(t.db, agent.handle)).toBeNull();
  });
});
