import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cases, evidence as evidenceTable, argumentsTable } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createGate } from "@/lib/safety/engine";
import { failClosedGate } from "@/lib/safety/stub";
import { GATE_VERSION } from "@/lib/safety/version";
import { submitArgument } from "@/lib/services/argumentService";
import { fileCase } from "@/lib/services/caseService";
import { rescanHeld } from "@/lib/services/rescanService";
import { runRescan } from "@/scripts/rescan-held";
import { passGate, throwingGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const NOW = new Date("2026-10-25T12:00:00.000Z");

// Assembled at run time: the repository is public and scanners flag whole tokens.
const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const withKey = (lead: string) => `${lead} the shell history held ${awsKey} and nothing else worth reading in it.`;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

// The re-scan looks at every held row, so each test starts from an empty queue.
beforeEach(async () => {
  await t.sql("reset role");
  await t.sql("truncate cases, moderation_events cascade");
  await t.sql("set role app_server");
});

const caseBody = (over: Record<string, unknown> = {}) => ({
  title: "Tool call loops",
  summary: withKey("Summary:"),
  expected: "One call.",
  actual: "Ten calls.",
  tags: [],
  environment: { model: "model-a", notes: withKey("Notes:") },
  evidence: [{ kind: "error", text: withKey("crash log:") }],
  ...over,
});

/** A held case exactly as the N3 stub left it: flagged, with the text unredacted. */
async function stubbedCase(over: Record<string, unknown> = {}) {
  const { actor } = await f.makeAgent();
  const filed = f.unwrap(await fileCase(t.db, failClosedGate, actor, caseBody(over), NOW));
  return { actor, case: filed.case, evidence: filed.evidence[0] };
}

async function stubbedArgument(over: Record<string, unknown> = {}) {
  const filer = await f.makeAgent();
  const author = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { status: "open" });
  const body = { reasoning: withKey("The loop has no exit;"), proposed_change: "Set max_retries to 1.", ...over };
  const submitted = f.unwrap(await submitArgument(t.db, failClosedGate, author.actor, c.id, body));
  return { case: c, argument: submitted.argument };
}

/** How many rows of the text tables still hold the secret. */
async function copiesOfKey(): Promise<number> {
  let total = 0;
  for (const table of ["cases", "evidence", "arguments", "moderation_events"]) {
    const rows = await t.sql(`select count(*)::int as n from ${table} x where x::text like $1`, [`%${awsKey}%`]);
    total += rows[0].n as number;
  }
  return total;
}

const currentEvents = (target: string) =>
  f.count(`moderation_events where target_id = $1 and details->>'version' = $2`, [target, GATE_VERSION]);
const caseStatus = async (id: string) => (await t.db.select().from(cases).where(eq(cases.id, id)))[0].status;
const evidenceStatus = async (id: string) => (await t.db.select().from(evidenceTable).where(eq(evidenceTable.id, id)))[0].status;
const argumentStatus = async (id: string) => (await t.db.select().from(argumentsTable).where(eq(argumentsTable.id, id)))[0].status;

const scan = (apply: boolean, limit = 100, offset = 0, gate = createGate()) =>
  rescanHeld(t.db, gate, { limit, apply, offset });

describe("rescanHeld: a dry run", () => {
  it("counts what would change and writes nothing", async () => {
    const c = await stubbedCase();
    const a = await stubbedArgument();
    const events = await f.count("moderation_events");
    expect(await copiesOfKey()).toBeGreaterThan(0);

    const summary = await scan(false);
    // The argument's own case is public and has no event at all, so it counts as screened by no current rules.
    expect(summary).toEqual({ examined: 2, redacted: 2, rejected: 0, unchanged: 0, failed: 0, publishedStale: 1 });
    expect(await f.count("moderation_events")).toBe(events);
    expect(await caseStatus(c.case.id)).toBe("held");
    expect(await argumentStatus(a.argument.id)).toBe("held");
    expect((await t.db.select().from(cases).where(eq(cases.id, c.case.id)))[0].summary).toContain(awsKey);
  });
});

describe("rescanHeld: applying", () => {
  it("redacts the stored text everywhere, records the current version once per item, and keeps everything held", async () => {
    const c = await stubbedCase();
    const a = await stubbedArgument();

    const summary = await scan(true);
    expect(summary).toMatchObject({ examined: 2, redacted: 2, rejected: 0, unchanged: 0, failed: 0 });
    expect(await copiesOfKey()).toBe(0);

    const [row] = await t.db.select().from(cases).where(eq(cases.id, c.case.id));
    expect(row.summary).toContain("[REDACTED:aws_access_key]");
    expect(JSON.stringify(row.environment)).toContain("[REDACTED:aws_access_key]");
    const [item] = await t.db.select().from(evidenceTable).where(eq(evidenceTable.id, c.evidence.id));
    expect(item.redactedText).toContain("[REDACTED:aws_access_key]");

    expect(await currentEvents(c.case.id)).toBe(1);
    expect(await currentEvents(c.evidence.id)).toBe(1);
    expect(await currentEvents(a.argument.id)).toBe(1);

    expect(await caseStatus(c.case.id)).toBe("held");
    expect(await evidenceStatus(c.evidence.id)).toBe("held");
    expect(await argumentStatus(a.argument.id)).toBe("held");
    expect(row.publishedAt).toBeNull();
  });

  it("finds nothing to do the second time", async () => {
    await stubbedCase();
    await stubbedArgument();
    await scan(true);
    expect(await scan(true)).toMatchObject({ examined: 0, redacted: 0, rejected: 0, unchanged: 0, failed: 0 });
    expect(await scan(false)).toMatchObject({ examined: 0 });
  });

  it("counts a clean held item as unchanged, records it, and keeps it held", async () => {
    const c = await stubbedCase({
      summary: "The agent repeats a call.",
      environment: { model: "model-a" },
      evidence: [{ kind: "trace", text: "step 1" }],
    });
    expect(await scan(true)).toMatchObject({ examined: 1, redacted: 0, rejected: 0, unchanged: 1 });
    expect(await currentEvents(c.case.id)).toBe(1);
    expect(await caseStatus(c.case.id)).toBe("held");
  });

  it("rejects a case whose text now blocks, with its held evidence, and redacts what it keeps", async () => {
    const c = await stubbedCase({ summary: awsKey });
    const a = await stubbedArgument({ proposed_change: awsKey });

    expect(await scan(true)).toMatchObject({ examined: 2, rejected: 2, redacted: 0, unchanged: 0 });
    expect(await caseStatus(c.case.id)).toBe("rejected");
    expect(await evidenceStatus(c.evidence.id)).toBe("rejected");
    expect(await argumentStatus(a.argument.id)).toBe("rejected");
    expect(await copiesOfKey()).toBe(0);
  });

  it("rejects only the evidence when only a held evidence item now blocks", async () => {
    const c = await stubbedCase({
      summary: "The agent repeats a call.",
      environment: { model: "model-a" },
      evidence: [{ kind: "error", text: awsKey }],
    });
    const summary = await scan(true);
    expect(summary.examined).toBe(1);
    expect(summary.rejected).toBe(0);
    expect(await evidenceStatus(c.evidence.id)).toBe("rejected");
    expect(await caseStatus(c.case.id)).toBe("held");
    expect(await copiesOfKey()).toBe(0);
  });

  it("re-screens held evidence on a public case as its own item", async () => {
    const filer = await f.makeAgent();
    const open = await f.insertCase(filer.actor.agentId, { status: "open" });
    const held = await f.insertEvidence(open.id, "held");
    await t.sql(`update evidence set redacted_text = $1 where id = $2`, [withKey("log:"), held.id]);
    expect(await scan(true)).toMatchObject({ examined: 1, redacted: 1 });
    expect(await copiesOfKey()).toBe(0);
    expect(await evidenceStatus(held.id)).toBe("held");
    expect(await caseStatus(open.id)).toBe("open");
  });

  it("never makes anything public, whatever the gate says", async () => {
    const c = await stubbedCase({
      summary: "The agent repeats a call.",
      environment: { model: "model-a" },
      evidence: [{ kind: "trace", text: "step 1" }],
    });
    const a = await stubbedArgument({ reasoning: "The loop has no exit." });
    await scan(true);
    expect(await caseStatus(c.case.id)).toBe("held");
    expect(await evidenceStatus(c.evidence.id)).toBe("held");
    expect(await argumentStatus(a.argument.id)).toBe("held");
  });
});

describe("rescanHeld: size and paging", () => {
  it("examines at most `limit` items and moves on with `offset`", async () => {
    for (let i = 0; i < 3; i++) await stubbedCase();
    expect((await scan(false, 2, 0)).examined).toBe(2);
    expect((await scan(false, 2, 2)).examined).toBe(1);
    expect((await scan(false, 2, 4)).examined).toBe(0);
  });

  it("works through the queue in batches when applying", async () => {
    for (let i = 0; i < 3; i++) await stubbedCase();
    expect((await scan(true, 2)).examined).toBe(2);
    expect((await scan(true, 2)).examined).toBe(1);
    expect((await scan(true, 2)).examined).toBe(0);
    expect(await copiesOfKey()).toBe(0);
  });
});

describe("rescanHeld: published content", () => {
  it("counts public cases whose newest event is not from the current version, and changes none", async () => {
    const filer = await f.makeAgent();
    const stale = [];
    for (const status of ["open", "argued", "resolved", "under_appeal", "closed_unresolved"] as const) {
      stale.push(await f.insertCase(filer.actor.agentId, { status, summary: withKey("Public:") }));
    }
    await f.insertCase(filer.actor.agentId, { status: "withdrawn" });
    f.unwrap(await fileCase(t.db, createGate(), (await f.makeAgent()).actor, caseBody({ summary: "The agent repeats a call.", environment: {}, evidence: [] }), NOW));
    f.unwrap(await fileCase(t.db, passGate, (await f.makeAgent()).actor, caseBody({ summary: "Another plain summary.", environment: {}, evidence: [] }), NOW));

    const summary = await scan(true);
    expect(summary.examined).toBe(0);
    expect(summary.publishedStale).toBe(6); // the five inserted without events, and the one the pass gate recorded
    for (const row of stale) {
      const [after] = await t.db.select().from(cases).where(eq(cases.id, row.id));
      expect(after.status).toBe(row.status);
      expect(after.summary).toContain(awsKey);
    }
  });
});

describe("rescanHeld: a gate that fails", () => {
  it("leaves the item held and unchanged, records nothing, and counts it as failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const c = await stubbedCase();
      const events = await f.count("moderation_events");
      const summary = await scan(true, 100, 0, throwingGate);
      expect(summary).toMatchObject({ examined: 1, failed: 1, redacted: 0, rejected: 0, unchanged: 0 });
      expect(await caseStatus(c.case.id)).toBe("held");
      expect((await t.db.select().from(cases).where(eq(cases.id, c.case.id)))[0].summary).toContain(awsKey);
      expect(await f.count("moderation_events")).toBe(events);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("runRescan", () => {
  it("sums the batches of an apply run until the queue is empty", async () => {
    for (let i = 0; i < 3; i++) await stubbedCase();
    await stubbedArgument();
    const summary = await runRescan(t.db, createGate(), true, 2);
    expect(summary).toMatchObject({ examined: 4, redacted: 4, rejected: 0, unchanged: 0, failed: 0 });
    expect(await copiesOfKey()).toBe(0);
  });

  it("pages through a dry run instead of looping on it, and writes nothing", async () => {
    for (let i = 0; i < 3; i++) await stubbedCase();
    const events = await f.count("moderation_events");
    const summary = await runRescan(t.db, createGate(), false, 1);
    expect(summary).toMatchObject({ examined: 3, redacted: 3 });
    expect(await f.count("moderation_events")).toBe(events);
    expect(await copiesOfKey()).toBeGreaterThan(0);
  });

  it("finishes when the gate keeps failing, and reports the failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 3; i++) await stubbedCase();
      const summary = await runRescan(t.db, throwingGate, true, 1);
      expect(summary).toMatchObject({ examined: 3, failed: 3, redacted: 0 });
    } finally {
      warn.mockRestore();
    }
  });

  it("reports the public cases screened by older rules once, not once per batch", async () => {
    const filer = await f.makeAgent();
    await f.insertCase(filer.actor.agentId, { status: "open" });
    for (let i = 0; i < 3; i++) await stubbedCase();
    const summary = await runRescan(t.db, createGate(), true, 1);
    expect(summary.publishedStale).toBe(1);
  });
});
