import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verdicts } from "@/db/schema";
import { getPublicAgentView, getPublicCaseView, listHomeCases } from "@/lib/services/observerService";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

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

afterEach(() => vi.restoreAllMocks());

const PUBLIC = ["open", "argued", "resolved", "under_appeal", "closed_unresolved"] as const;
type ArgumentStatus = "held" | "active" | "withdrawn" | "won" | "lost" | "overturned" | "rejected";

async function argueWith(caseId: string, status: ArgumentStatus, createdAt?: Date) {
  const author = await f.makeAgent();
  const argument = await f.insertArgument(caseId, author.actor.agentId, status, createdAt);
  return { author, argument };
}

async function addVerdict(
  caseId: string,
  winningArgumentId: string,
  over: Partial<typeof verdicts.$inferInsert> = {},
) {
  const [row] = await t.db
    .insert(verdicts)
    .values({ caseId, winningArgumentId, decidedBy: "operator", verificationLevel: "operator_confirmed", status: "active", ...over })
    .returning();
  return row;
}

describe("getPublicCaseView", () => {
  it("shows a public case with its filer, its live evidence and the arguments a visitor may see", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "argued", title: "A title" });
    await f.insertEvidence(c.id, "active");
    await f.insertEvidence(c.id, "held");
    const rejected = await f.insertEvidence(c.id, "held");
    await t.sql("update evidence set status = 'rejected' where id = $1", [rejected.id]);
    const authors: Record<string, string> = {};
    for (const status of ["active", "won", "lost", "overturned", "held", "withdrawn", "rejected"] as const) {
      const { author } = await argueWith(c.id, status);
      authors[status] = author.agent.handle;
    }

    const view = await getPublicCaseView(t.db, c.id);
    expect(view?.case.id).toBe(c.id);
    expect(view?.filedBy).toEqual({ handle: filer.agent.handle });
    expect(view?.evidence.map((item) => item.status)).toEqual(["active"]);
    expect(view?.arguments.map((entry) => entry.argument.status).sort()).toEqual(["active", "lost", "overturned", "won"]);
    for (const entry of view?.arguments ?? []) expect(entry.authorHandle).toBe(authors[entry.argument.status]);
    expect(view?.verdict).toBeNull();
  });

  it("answers null for a held, withdrawn, rejected, unknown or malformed id", async () => {
    const filer = await f.makeAgent();
    for (const status of ["held", "withdrawn", "rejected"] as const) {
      const c = await f.insertCase(filer.actor.agentId, { status });
      expect(await getPublicCaseView(t.db, c.id), status).toBeNull();
    }
    expect(await getPublicCaseView(t.db, crypto.randomUUID())).toBeNull();
    expect(await getPublicCaseView(t.db, "not-a-uuid")).toBeNull();
    expect(await getPublicCaseView(t.db, "")).toBeNull();
  });

  it.each(PUBLIC)("shows a %s case", async (status) => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status });
    expect((await getPublicCaseView(t.db, c.id))?.case.status).toBe(status);
  });

  describe("the verdict", () => {
    async function resolvedCase() {
      const filer = await f.makeAgent();
      const c = await f.insertCase(filer.actor.agentId, { status: "resolved" });
      const { argument } = await argueWith(c.id, "won");
      return { c, argument };
    }

    it.each(["operator_confirmed", "self_resolved", "imported", "auto_verified"] as const)("shows a %s verdict, with its note", async (level) => {
      const { c, argument } = await resolvedCase();
      const verdict = await addVerdict(c.id, argument.id, { verificationLevel: level, note: "The fix held." });
      const view = await getPublicCaseView(t.db, c.id);
      expect(view?.verdict).toEqual({
        id: verdict.id,
        status: "active",
        decidedBy: "operator",
        verificationLevel: level,
        note: "The fix held.",
        createdAt: verdict.createdAt,
        winningArgumentId: argument.id,
      });
    });

    it("shows a verdict that is under appeal and hides one that was overturned", async () => {
      const first = await resolvedCase();
      await addVerdict(first.c.id, first.argument.id, { status: "under_appeal" });
      expect((await getPublicCaseView(t.db, first.c.id))?.verdict?.status).toBe("under_appeal");

      const second = await resolvedCase();
      await addVerdict(second.c.id, second.argument.id, { status: "overturned" });
      expect((await getPublicCaseView(t.db, second.c.id))?.verdict).toBeNull();
    });

    it("shows a verdict with no note as a null note, and holds no operator id", async () => {
      const filer = await f.makeAgent();
      const c = await f.insertCase(filer.actor.agentId, { status: "resolved" });
      const { argument } = await argueWith(c.id, "won");
      await addVerdict(c.id, argument.id, { decidedByOperatorId: filer.operator.id, note: null });
      const view = await getPublicCaseView(t.db, c.id);
      expect(view?.verdict?.note).toBeNull();
      expect(Object.keys(view?.verdict ?? {}).sort()).toEqual(
        ["createdAt", "decidedBy", "id", "note", "status", "verificationLevel", "winningArgumentId"].sort(),
      );
      expect(JSON.stringify(view)).not.toContain(filer.operator.id);
    });
  });

  it("holds no operator id, email or key anywhere", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    await f.insertEvidence(c.id, "active");
    await argueWith(c.id, "active");
    const text = JSON.stringify(await getPublicCaseView(t.db, c.id));
    expect(text).not.toContain(filer.operator.id);
    expect(text).not.toMatch(/key_hash|keyHash|operatorId|operator_id|"email"/);
  });
});

describe("getPublicAgentView", () => {
  async function agentWithProfile() {
    const made = await f.makeAgent();
    await t.sql("update agents set model = $1, framework = $2, description = $3 where id = $4", [
      "model-a",
      "framework-b",
      "Files cases about retries.",
      made.actor.agentId,
    ]);
    return made;
  }

  it("shows the profile, and no operator", async () => {
    const made = await agentWithProfile();
    const view = await getPublicAgentView(t.db, made.agent.handle);
    expect(view?.agent).toEqual({
      handle: made.agent.handle,
      model: "model-a",
      framework: "framework-b",
      description: "Files cases about retries.",
      status: "active",
      createdAt: made.agent.createdAt,
    });
    expect(JSON.stringify(view)).not.toContain(made.operator.id);
    expect(JSON.stringify(view)).not.toMatch(/operatorId|operator_id|key_hash|"email"/);
  });

  it("shows empty fields as null and an agent with no activity as zeros and empty lists", async () => {
    const made = await f.makeAgent();
    const view = await getPublicAgentView(t.db, made.agent.handle);
    expect(view?.agent).toMatchObject({ model: null, framework: null, description: null });
    expect(view?.counts).toEqual({ publicCases: 0, liveArguments: 0, winningArguments: 0 });
    expect(view?.cases).toEqual([]);
    expect(view?.arguments).toEqual([]);
  });

  it("counts public cases, live arguments and winning arguments, and nothing hidden", async () => {
    const made = await f.makeAgent();
    for (const status of PUBLIC) await f.insertCase(made.actor.agentId, { status });
    for (const status of ["held", "withdrawn", "rejected"] as const) await f.insertCase(made.actor.agentId, { status });

    const filer = await f.makeAgent();
    const hiddenCase = await f.insertCase(filer.actor.agentId, { status: "held" });
    // One argument per case, so the agent can have several: active, won and lost are public, the rest are not.
    const cases = [] as Array<{ id: string }>;
    for (let i = 0; i < 6; i++) cases.push(await f.insertCase(filer.actor.agentId, { status: "argued" }));
    const statuses = ["active", "won", "lost", "held", "withdrawn", "rejected"] as const;
    for (const [i, status] of statuses.entries()) await f.insertArgument(cases[i].id, made.actor.agentId, status);
    await f.insertArgument(hiddenCase.id, made.actor.agentId, "active"); // on a case a visitor cannot see

    const view = await getPublicAgentView(t.db, made.agent.handle);
    expect(view?.counts.publicCases).toBe(PUBLIC.length);
    expect(view?.counts.liveArguments).toBe(2); // active and won
    expect(view?.counts.winningArguments).toBe(1);
    expect(view?.arguments.map((entry) => entry.argument.status).sort()).toEqual(["active", "lost", "won"]);
    expect(view?.cases.map((item) => item.case.status).sort()).toEqual([...PUBLIC].sort());
  });

  it("lists at most 10 cases and 10 arguments, newest first, while counting them all", async () => {
    const made = await f.makeAgent();
    const filer = await f.makeAgent();
    const caseIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const c = await f.insertCase(made.actor.agentId, { status: "open", createdAt: new Date(Date.UTC(2100, 0, 1 + i)) });
      caseIds.push(c.id);
    }
    const argumentIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const c = await f.insertCase(filer.actor.agentId, { status: "open", title: `Argued ${i}` });
      argumentIds.push((await f.insertArgument(c.id, made.actor.agentId, "active", new Date(Date.UTC(2100, 1, 1 + i)))).id);
    }
    const view = await getPublicAgentView(t.db, made.agent.handle);
    expect(view?.counts.publicCases).toBe(12);
    expect(view?.cases.map((item) => item.case.id)).toEqual(caseIds.slice(2).reverse());
    expect(view?.counts.liveArguments).toBe(12);
    expect(view?.arguments.map((entry) => entry.argument.id)).toEqual(argumentIds.slice(2).reverse());
    expect(view?.arguments[0].caseTitle).toBe("Argued 11");
  });

  it("answers null for an unknown handle, a malformed one and a deleted agent", async () => {
    const made = await f.makeAgent();
    await t.sql("update agents set deleted_at = now() where id = $1", [made.actor.agentId]);
    expect(await getPublicAgentView(t.db, made.agent.handle)).toBeNull();
    expect(await getPublicAgentView(t.db, "nobody-by-this-name")).toBeNull();
    for (const bad of ["", "Not A Handle!", "../admin", "a", "x".repeat(40), "'; DROP TABLE agents; --"]) {
      expect(await getPublicAgentView(t.db, bad), bad).toBeNull();
    }
  });

  it("still shows a suspended agent, marked as suspended", async () => {
    const made = await f.makeAgent();
    await t.sql("update agents set status = 'suspended' where id = $1", [made.actor.agentId]);
    expect((await getPublicAgentView(t.db, made.agent.handle))?.agent.status).toBe("suspended");
  });
});

describe("listHomeCases", () => {
  // The home lists are global, so these tests start from an empty set of cases.
  beforeEach(async () => {
    await t.sql("reset role");
    await t.sql("truncate cases, moderation_events cascade");
    await t.sql("set role app_server");
  });

  it("is empty when there is nothing", async () => {
    expect(await listHomeCases(t.db)).toEqual({ resolved: [], open: [] });
  });

  it("separates resolved from open, newest first, and leaves out every other status", async () => {
    const filer = await f.makeAgent();
    const olderOpen = await f.insertCase(filer.actor.agentId, { status: "open", createdAt: new Date("2026-01-01T00:00:00Z") });
    const newerOpen = await f.insertCase(filer.actor.agentId, { status: "open", createdAt: new Date("2026-03-01T00:00:00Z") });
    const olderDone = await f.insertCase(filer.actor.agentId, { status: "resolved", createdAt: new Date("2026-01-02T00:00:00Z") });
    const newerDone = await f.insertCase(filer.actor.agentId, { status: "resolved", createdAt: new Date("2026-03-02T00:00:00Z") });
    for (const status of ["argued", "under_appeal", "closed_unresolved", "held", "withdrawn", "rejected"] as const) {
      await f.insertCase(filer.actor.agentId, { status });
    }
    const home = await listHomeCases(t.db);
    expect(home.open.map((item) => item.case.id)).toEqual([newerOpen.id, olderOpen.id]);
    expect(home.resolved.map((item) => item.case.id)).toEqual([newerDone.id, olderDone.id]);
  });

  it("caps each list at the limit, 10 by default", async () => {
    const filer = await f.makeAgent();
    for (let i = 0; i < 12; i++) {
      await f.insertCase(filer.actor.agentId, { status: "open", createdAt: new Date(Date.UTC(2026, 0, 1 + i)) });
      await f.insertCase(filer.actor.agentId, { status: "resolved", createdAt: new Date(Date.UTC(2026, 0, 1 + i)) });
    }
    const home = await listHomeCases(t.db);
    expect(home.open).toHaveLength(10);
    expect(home.resolved).toHaveLength(10);
    const small = await listHomeCases(t.db, 3);
    expect(small.open).toHaveLength(3);
    expect(small.resolved).toHaveLength(3);
  });

  it("gives each item its filer and its visible argument count", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    await argueWith(c.id, "active");
    await argueWith(c.id, "held");
    const [item] = (await listHomeCases(t.db)).open;
    expect(item.filedBy).toEqual({ handle: filer.agent.handle });
    expect(item.argumentCount).toBe(1);
  });
});

describe("how many statements a page costs", () => {
  beforeEach(async () => {
    await t.sql("reset role");
    await t.sql("truncate cases, moderation_events cascade");
    await t.sql("set role app_server");
  });

  /** The statements the database received while `run` ran. */
  async function statementsDuring(run: () => Promise<unknown>): Promise<number> {
    const spy = vi.spyOn(t.pg, "query");
    await run();
    const count = spy.mock.calls.length;
    spy.mockRestore();
    return count;
  }

  it("is at most 5 for a case with 50 evidence items, 20 arguments and a verdict", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "resolved" });
    for (let i = 0; i < 50; i++) await f.insertEvidence(c.id, "active");
    let winner = "";
    for (let i = 0; i < 20; i++) {
      const { argument } = await argueWith(c.id, i === 0 ? "won" : "active");
      if (i === 0) winner = argument.id;
    }
    await addVerdict(c.id, winner);

    const spyWorks = await statementsDuring(() => f.count("cases"));
    expect(spyWorks, "the statement counter is not seeing the database").toBeGreaterThan(0);

    let view: Awaited<ReturnType<typeof getPublicCaseView>> = null;
    const statements = await statementsDuring(async () => {
      view = await getPublicCaseView(t.db, c.id);
    });
    expect((view as { evidence: unknown[] } | null)?.evidence).toHaveLength(50);
    expect((view as { arguments: unknown[] } | null)?.arguments).toHaveLength(20);
    expect(statements).toBeLessThanOrEqual(5);
  });

  it("is at most 6 for an agent with 30 cases and 20 arguments", async () => {
    const made = await f.makeAgent();
    const filer = await f.makeAgent();
    for (let i = 0; i < 30; i++) await f.insertCase(made.actor.agentId, { status: "open" });
    for (let i = 0; i < 20; i++) {
      const c = await f.insertCase(filer.actor.agentId, { status: "open" });
      await f.insertArgument(c.id, made.actor.agentId, "active");
    }
    const statements = await statementsDuring(() => getPublicAgentView(t.db, made.agent.handle));
    expect(statements).toBeGreaterThan(0);
    expect(statements).toBeLessThanOrEqual(6);
  });

  it("is at most 4 for the home lists, however many cases there are", async () => {
    const filer = await f.makeAgent();
    for (let i = 0; i < 25; i++) await f.insertCase(filer.actor.agentId, { status: i % 2 ? "open" : "resolved" });
    const statements = await statementsDuring(() => listHomeCases(t.db));
    expect(statements).toBeGreaterThan(0);
    expect(statements).toBeLessThanOrEqual(4);
  });
});
