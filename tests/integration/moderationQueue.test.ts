import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { moderationEvents } from "@/db/schema";
import { loadModerationQueue } from "@/lib/admin/queue";
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

const ALL = { limit: 1000 };
const ids = <T extends { id: string }>(items: T[], mine: Set<string>) => items.map((item) => item.id).filter((id) => mine.has(id));

async function event(
  targetType: "case" | "evidence" | "argument",
  targetId: string,
  details: Record<string, unknown>,
  createdAt: Date,
) {
  await t.db.insert(moderationEvents).values({ targetType, targetId, check: "injection", result: "flag", details, createdAt });
}

describe("loadModerationQueue: what is listed", () => {
  it("lists held cases only", async () => {
    const { actor } = await f.makeAgent();
    const held = await f.insertCase(actor.agentId, { status: "held" });
    const others = await Promise.all(
      (["open", "rejected", "withdrawn", "argued", "resolved"] as const).map((status) => f.insertCase(actor.agentId, { status })),
    );
    const queue = await loadModerationQueue(t.db, ALL);
    const mine = new Set([held.id, ...others.map((c) => c.id)]);
    expect(ids(queue.cases, mine)).toEqual([held.id]);
  });

  it("fills in a case with its handle, text, environment and tags", async () => {
    const { agent, actor } = await f.makeAgent();
    const c = await f.insertCase(actor.agentId, {
      status: "held",
      title: "Title here",
      summary: "Summary here",
      expected: "Expected here",
      actual: "Actual here",
      environment: { model: "model-a" },
      tags: ["tool-call"],
    });
    const queue = await loadModerationQueue(t.db, ALL);
    const item = queue.cases.find((entry) => entry.id === c.id);
    expect(item).toMatchObject({
      agentHandle: agent.handle,
      title: "Title here",
      summary: "Summary here",
      expected: "Expected here",
      actual: "Actual here",
      environment: { model: "model-a" },
      tags: ["tool-call"],
    });
    expect(item?.createdAt).toBeInstanceOf(Date);
  });

  it("nests a held case's held evidence under it and does not list it twice", async () => {
    const { actor } = await f.makeAgent();
    const c = await f.insertCase(actor.agentId, { status: "held" });
    const heldEvidence = await f.insertEvidence(c.id, "held");
    const activeEvidence = await f.insertEvidence(c.id, "active");
    const queue = await loadModerationQueue(t.db, ALL);
    const item = queue.cases.find((entry) => entry.id === c.id);
    expect(item?.evidence).toEqual([{ id: heldEvidence.id, kind: "trace", text: "x" }]);
    const listed = queue.evidence.map((entry) => entry.id);
    expect(listed).not.toContain(heldEvidence.id);
    expect(listed).not.toContain(activeEvidence.id);
  });

  it("lists held evidence on a case that is already public, and only held evidence", async () => {
    const { agent, actor } = await f.makeAgent();
    const c = await f.insertCase(actor.agentId, { status: "open", title: "Public case" });
    const held = await f.insertEvidence(c.id, "held");
    const active = await f.insertEvidence(c.id, "active");
    const queue = await loadModerationQueue(t.db, ALL);
    const mine = new Set([held.id, active.id]);
    expect(ids(queue.evidence, mine)).toEqual([held.id]);
    expect(queue.evidence.find((entry) => entry.id === held.id)).toMatchObject({
      caseId: c.id,
      caseTitle: "Public case",
      agentHandle: agent.handle,
      kind: "trace",
      text: "x",
    });
  });

  it("lists held arguments only, with the case title and the author's handle", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open", title: "Argued case" });
    const held = await f.insertArgument(c.id, author.actor.agentId, "held");
    const others = await Promise.all(
      (["active", "withdrawn", "rejected", "won"] as const).map(async (status) =>
        f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, status),
      ),
    );
    const queue = await loadModerationQueue(t.db, ALL);
    const mine = new Set([held.id, ...others.map((a) => a.id)]);
    expect(ids(queue.arguments, mine)).toEqual([held.id]);
    expect(queue.arguments.find((entry) => entry.id === held.id)).toMatchObject({
      caseId: c.id,
      caseTitle: "Argued case",
      agentHandle: author.agent.handle,
      reasoning: "r",
      proposedChange: "p",
    });
  });
});

describe("loadModerationQueue: order and size", () => {
  it("lists the oldest first", async () => {
    const { actor } = await f.makeAgent();
    const newest = await f.insertCase(actor.agentId, { status: "held", createdAt: new Date("1991-03-01T00:00:00Z") });
    const oldest = await f.insertCase(actor.agentId, { status: "held", createdAt: new Date("1991-01-01T00:00:00Z") });
    const middle = await f.insertCase(actor.agentId, { status: "held", createdAt: new Date("1991-02-01T00:00:00Z") });
    const queue = await loadModerationQueue(t.db, ALL);
    expect(ids(queue.cases, new Set([newest.id, oldest.id, middle.id]))).toEqual([oldest.id, middle.id, newest.id]);

    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const later = await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "held", new Date("1991-05-01T00:00:00Z"));
    const earlier = await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "held", new Date("1991-04-01T00:00:00Z"));
    const withArguments = await loadModerationQueue(t.db, ALL);
    expect(ids(withArguments.arguments, new Set([later.id, earlier.id]))).toEqual([earlier.id, later.id]);
  });

  it("returns at most `limit` items per kind and says when it cut the list", async () => {
    const { actor } = await f.makeAgent();
    const made = [];
    for (const day of ["1990-01-01", "1990-01-02", "1990-01-03"]) {
      made.push(await f.insertCase(actor.agentId, { status: "held", createdAt: new Date(`${day}T00:00:00Z`) }));
    }
    const cut = await loadModerationQueue(t.db, { limit: 2 });
    expect(cut.cases.map((c) => c.id)).toEqual([made[0].id, made[1].id]);
    expect(cut.truncated).toBe(true);

    const whole = await loadModerationQueue(t.db, ALL);
    expect(whole.truncated).toBe(false);
  });

  it("defaults to 50 items per kind", async () => {
    const queue = await loadModerationQueue(t.db);
    expect(queue.cases.length).toBeLessThanOrEqual(50);
    expect(queue.evidence.length).toBeLessThanOrEqual(50);
    expect(queue.arguments.length).toBeLessThanOrEqual(50);
  });
});

describe("loadModerationQueue: the gate summary", () => {
  const report = {
    version: "2026-10-25.2",
    outcome: "flag",
    redactions: { total: 3, types: { email: 2, phone: 1 } },
    fields: {
      title: {
        outcome: "flag",
        score: 4,
        hits: [{ rule: "ignore_previous", count: 2, weight: 3 }],
        redactions: [{ type: "email", start: 3, length: 10 }],
        links: { total: 0, dangerous: {}, beacons: 0 },
      },
      summary: {
        outcome: "pass",
        score: 1,
        hits: [
          { rule: "ignore_previous", count: 1, weight: 3 },
          { rule: "role_marker", count: 1, weight: 1 },
        ],
        redactions: [],
        links: { total: 0, dangerous: {}, beacons: 0 },
      },
    },
  };

  it("sums rules over fields and lists redaction types with counts, with no positions", async () => {
    const { actor } = await f.makeAgent();
    const c = await f.insertCase(actor.agentId, { status: "held" });
    await event("case", c.id, report, new Date("2026-10-25T10:00:00Z"));
    const item = (await loadModerationQueue(t.db, ALL)).cases.find((entry) => entry.id === c.id);
    expect(item?.gate).toEqual({
      version: "2026-10-25.2",
      outcome: "flag",
      rules: [
        { rule: "ignore_previous", count: 3 },
        { rule: "role_marker", count: 1 },
      ],
      redactions: [
        { type: "email", count: 2 },
        { type: "phone", count: 1 },
      ],
    });
    expect(JSON.stringify(item?.gate)).not.toMatch(/start|length|score/);
  });

  it("uses the newest event for the item", async () => {
    const { actor } = await f.makeAgent();
    const c = await f.insertCase(actor.agentId, { status: "held" });
    await event("case", c.id, { ...report, version: "old", outcome: "pass" }, new Date("2026-10-25T09:00:00Z"));
    await event("case", c.id, { ...report, version: "new" }, new Date("2026-10-25T11:00:00Z"));
    const item = (await loadModerationQueue(t.db, ALL)).cases.find((entry) => entry.id === c.id);
    expect(item?.gate?.version).toBe("new");
  });

  it("gives empty values for an event the N3 stub wrote, and null when there is no event", async () => {
    const { actor } = await f.makeAgent();
    const stubbed = await f.insertCase(actor.agentId, { status: "held" });
    const bare = await f.insertCase(actor.agentId, { status: "held" });
    await event("case", stubbed.id, { stub: true }, new Date("2026-10-25T10:00:00Z"));
    const queue = await loadModerationQueue(t.db, ALL);
    expect(queue.cases.find((entry) => entry.id === stubbed.id)?.gate).toEqual({
      version: null,
      outcome: null,
      rules: [],
      redactions: [],
    });
    expect(queue.cases.find((entry) => entry.id === bare.id)?.gate).toBeNull();
  });

  it("does not mix up events of different kinds that share nothing but a type", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const e = await f.insertEvidence(c.id, "held");
    const a = await f.insertArgument(c.id, author.actor.agentId, "held");
    await event("evidence", e.id, { ...report, version: "evidence-report" }, new Date("2026-10-25T10:00:00Z"));
    await event("argument", a.id, { ...report, version: "argument-report" }, new Date("2026-10-25T10:00:00Z"));
    const queue = await loadModerationQueue(t.db, ALL);
    expect(queue.evidence.find((entry) => entry.id === e.id)?.gate?.version).toBe("evidence-report");
    expect(queue.arguments.find((entry) => entry.id === a.id)?.gate?.version).toBe("argument-report");
  });
});

describe("loadModerationQueue: what it keeps out", () => {
  it("holds no operator id, agent id or key data", async () => {
    const { agent, actor, operator } = await f.makeAgent();
    const c = await f.insertCase(actor.agentId, { status: "held" });
    await f.insertEvidence(c.id, "held");
    const queue = await loadModerationQueue(t.db, ALL);
    const text = JSON.stringify(queue);
    expect(text).toContain(agent.handle);
    expect(text).not.toContain(operator.id);
    expect(text).not.toContain(actor.agentId);
    expect(text).not.toMatch(/operatorId|agentId|keyHash|key_hash/);
  });
});
