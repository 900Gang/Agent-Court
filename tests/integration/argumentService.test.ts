import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { argumentsTable, cases } from "@/db/schema";
import type { GateInput, SafetyGate } from "@/lib/safety/gate";
import { createGate } from "@/lib/safety/engine";
import { failClosedGate } from "@/lib/safety/stub";
import {
  publishHeldArgument,
  rejectHeldArgument,
  submitArgument,
  withdrawArgument,
} from "@/lib/services/argumentService";
import { getCase } from "@/lib/services/caseService";
import { blockGate, passGate, throwingGate } from "../helpers/gates";
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

const fix = { reasoning: "The loop has no exit.", proposed_change: "Set max_retries to 1." };

async function caseStatusOf(caseId: string) {
  const [row] = await t.db.select().from(cases).where(eq(cases.id, caseId));
  return row.status;
}

async function argumentStatusOf(argumentId: string) {
  const [row] = await t.db.select().from(argumentsTable).where(eq(argumentsTable.id, argumentId));
  return row.status;
}

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

describe("submitArgument: publishing", () => {
  it("publishes the argument and moves an open case to argued when the gate passes", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const result = f.unwrap(await submitArgument(t.db, passGate, author.actor, c.id, fix));
    expect(result.held).toBe(false);
    expect(result.caseStatus).toBe("argued");
    expect(result.argument).toMatchObject({
      caseId: c.id,
      agentId: author.actor.agentId,
      reasoning: fix.reasoning,
      proposedChange: fix.proposed_change,
      status: "active",
    });
    expect(await caseStatusOf(c.id)).toBe("argued");
  });

  it("holds the argument and leaves the case open when the gate flags", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const result = f.unwrap(await submitArgument(t.db, failClosedGate, author.actor, c.id, fix));
    expect(result.held).toBe(true);
    expect(result.argument.status).toBe("held");
    expect(result.caseStatus).toBe("open");
    expect(await caseStatusOf(c.id)).toBe("open");
  });

  it("holds the argument when the gate throws", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const result = f.unwrap(await submitArgument(t.db, throwingGate, author.actor, c.id, fix));
    expect(result.held).toBe(true);
    expect(result.caseStatus).toBe("open");
  });

  it("keeps an argued case argued when another argument arrives, held or not", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "argued" });
    const a = f.unwrap(await submitArgument(t.db, passGate, (await f.makeAgent()).actor, c.id, fix));
    const b = f.unwrap(await submitArgument(t.db, failClosedGate, (await f.makeAgent()).actor, c.id, fix));
    expect(a.caseStatus).toBe("argued");
    expect(b.caseStatus).toBe("argued");
  });

  it("stores the text the gate returns", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const shouting: SafetyGate = {
      screen: async (input) => ({
        outcome: "pass",
        fields: Object.fromEntries(Object.entries(input.fields).map(([key, value]) => [key, value.toUpperCase()])),
        report: {},
      }),
    };
    const { argument } = f.unwrap(await submitArgument(t.db, shouting, author.actor, c.id, fix));
    expect(argument.reasoning).toBe("THE LOOP HAS NO EXIT.");
    expect(argument.proposedChange).toBe("SET MAX_RETRIES TO 1.");
  });

  it("records a moderation event and an audit row that holds ids only", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const { argument } = f.unwrap(await submitArgument(t.db, passGate, author.actor, c.id, fix));
    expect(await f.count("moderation_events where target_id = $1 and target_type = 'argument' and result = 'pass'", [argument.id])).toBe(1);
    const rows = await t.sql(`select action, actor_type, actor_id, metadata::text as text from audit_log where target = $1`, [argument.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "argument.submitted", actor_type: "agent", actor_id: author.actor.agentId });
    expect(rows[0].text).not.toContain("The loop has no exit");
  });
});

describe("submitArgument: refusals", () => {
  it("refuses an agent arguing on its own case", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    expect(f.errorOf(await submitArgument(t.db, passGate, filer.actor, c.id, fix))).toBe("self_argument");
    expect(await f.count("arguments where case_id = $1", [c.id])).toBe(0);
  });

  it("allows a second agent of the same operator", async () => {
    const filer = await f.makeAgent();
    const sibling = await f.makeAgent(filer.operator);
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    expect(f.unwrap(await submitArgument(t.db, passGate, sibling.actor, c.id, fix)).held).toBe(false);
  });

  it("refuses a second argument from the same agent", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    f.unwrap(await submitArgument(t.db, passGate, author.actor, c.id, fix));
    expect(f.errorOf(await submitArgument(t.db, passGate, author.actor, c.id, fix))).toBe("already_argued");
    expect(await f.count("arguments where case_id = $1", [c.id])).toBe(1);
  });

  it("refuses a second argument while the first is still held", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    f.unwrap(await submitArgument(t.db, failClosedGate, author.actor, c.id, fix));
    expect(f.errorOf(await submitArgument(t.db, passGate, author.actor, c.id, fix))).toBe("already_argued");
  });

  it("refuses the 21st argument, counting held ones, but accepts the 20th", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "argued" });
    for (let i = 0; i < 18; i++) await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, i % 2 ? "held" : "active");
    expect(f.unwrap(await submitArgument(t.db, passGate, (await f.makeAgent()).actor, c.id, fix)).held).toBe(false);
    expect(f.unwrap(await submitArgument(t.db, passGate, (await f.makeAgent()).actor, c.id, fix)).held).toBe(false);
    expect(f.errorOf(await submitArgument(t.db, passGate, (await f.makeAgent()).actor, c.id, fix))).toBe("argument_limit");
    expect(await f.count("arguments where case_id = $1 and status in ('held', 'active')", [c.id])).toBe(20);
  });

  it("does not count withdrawn arguments toward the limit", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "argued" });
    for (let i = 0; i < 20; i++) await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "withdrawn");
    expect(f.unwrap(await submitArgument(t.db, passGate, (await f.makeAgent()).actor, c.id, fix)).held).toBe(false);
  });

  it.each(["held", "withdrawn", "rejected"] as const)("answers not_found for another agent's %s case", async (status) => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status });
    expect(f.errorOf(await submitArgument(t.db, passGate, author.actor, c.id, fix))).toBe("not_found");
  });

  it("answers not_found for unknown ids and ids that are not UUIDs, without calling the gate", async () => {
    const author = await f.makeAgent();
    const { gate, calls } = spyGate();
    for (const id of ["not-a-uuid", "", "%00", crypto.randomUUID()]) {
      expect(f.errorOf(await submitArgument(t.db, gate, author.actor, id, fix))).toBe("not_found");
    }
    expect(calls).toHaveLength(0);
  });

  it.each(["resolved", "under_appeal", "closed_unresolved"] as const)("refuses an argument on a %s case", async (status) => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status });
    expect(f.errorOf(await submitArgument(t.db, passGate, author.actor, c.id, fix))).toBe("illegal_transition");
  });

  it("reports self_argument before the case state, so the reason is the same on every status", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "resolved" });
    expect(f.errorOf(await submitArgument(t.db, passGate, filer.actor, c.id, fix))).toBe("self_argument");
  });

  it("rejects invalid input without calling the gate", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const { gate, calls } = spyGate();
    const result = await submitArgument(t.db, gate, author.actor, c.id, { reasoning: "only this" });
    expect(f.errorOf(result)).toBe("invalid");
    expect(!result.ok && result.detail).toHaveProperty("proposed_change");
    expect(calls).toHaveLength(0);
  });

  it("stores nothing but a moderation event when the gate blocks", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const before = await f.count("moderation_events where target_type = 'argument' and target_id is null and result = 'block'");
    expect(f.errorOf(await submitArgument(t.db, blockGate, author.actor, c.id, fix))).toBe("blocked");
    expect(await f.count("arguments where case_id = $1", [c.id])).toBe(0);
    expect(await f.count("moderation_events where target_type = 'argument' and target_id is null and result = 'block'")).toBe(before + 1);
    expect(await caseStatusOf(c.id)).toBe("open");
  });
});

describe("submitArgument: simultaneous requests", () => {
  // PGlite runs one transaction at a time, so these prove the rules hold when two requests are in flight.
  // The row lock itself (SELECT ... FOR UPDATE) is what protects a real multi-connection database.
  it("lets only one of two agents take the last slot", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "argued" });
    for (let i = 0; i < 19; i++) await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "active");
    const [one, two] = [await f.makeAgent(), await f.makeAgent()];
    const results = await Promise.all([
      submitArgument(t.db, passGate, one.actor, c.id, fix),
      submitArgument(t.db, passGate, two.actor, c.id, fix),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => f.errorOf(r))).toEqual(["argument_limit"]);
    expect(await f.count("arguments where case_id = $1 and status in ('held', 'active')", [c.id])).toBe(20);
  });

  it("lets one agent submit only once when it sends two requests at the same time", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const results = await Promise.all([
      submitArgument(t.db, passGate, author.actor, c.id, fix),
      submitArgument(t.db, passGate, author.actor, c.id, fix),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => f.errorOf(r))).toEqual(["already_argued"]);
    expect(await f.count("arguments where case_id = $1", [c.id])).toBe(1);
  });
});

describe("withdrawArgument", () => {
  it("returns the case to open when the only active argument is withdrawn", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const { argument } = f.unwrap(await submitArgument(t.db, passGate, author.actor, c.id, fix));
    const result = f.unwrap(await withdrawArgument(t.db, author.actor, argument.id));
    expect(result.argument.status).toBe("withdrawn");
    expect(result.caseStatus).toBe("open");
    expect(await caseStatusOf(c.id)).toBe("open");
    expect(await f.count("audit_log where target = $1 and action = 'argument.withdrawn' and actor_type = 'agent'", [argument.id])).toBe(1);
  });

  it("keeps the case argued while another active argument remains", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "argued" });
    const mine = await f.makeAgent();
    const mineArg = await f.insertArgument(c.id, mine.actor.agentId, "active");
    await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "active");
    expect(f.unwrap(await withdrawArgument(t.db, mine.actor, mineArg.id)).caseStatus).toBe("argued");
  });

  it("does not count held arguments as a reason to stay argued", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "argued" });
    const mine = await f.makeAgent();
    const mineArg = await f.insertArgument(c.id, mine.actor.agentId, "active");
    await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "held");
    expect(f.unwrap(await withdrawArgument(t.db, mine.actor, mineArg.id)).caseStatus).toBe("open");
  });

  it("withdraws a held argument and leaves an open case open", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const { argument } = f.unwrap(await submitArgument(t.db, failClosedGate, author.actor, c.id, fix));
    const result = f.unwrap(await withdrawArgument(t.db, author.actor, argument.id));
    expect(result.argument.status).toBe("withdrawn");
    expect(result.caseStatus).toBe("open");
  });

  it("leaves a resolved case alone", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "resolved" });
    const arg = await f.insertArgument(c.id, author.actor.agentId, "active");
    expect(f.unwrap(await withdrawArgument(t.db, author.actor, arg.id)).caseStatus).toBe("resolved");
  });

  it("lets the agent argue again after withdrawing", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const first = f.unwrap(await submitArgument(t.db, passGate, author.actor, c.id, fix));
    f.unwrap(await withdrawArgument(t.db, author.actor, first.argument.id));
    expect(f.unwrap(await submitArgument(t.db, passGate, author.actor, c.id, fix)).held).toBe(false);
  });

  it("refuses to withdraw a won argument and leaves it unchanged", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "resolved" });
    const won = await f.insertArgument(c.id, author.actor.agentId, "won");
    expect(f.errorOf(await withdrawArgument(t.db, author.actor, won.id))).toBe("verdict_locked");
    expect(await argumentStatusOf(won.id)).toBe("won");
  });

  it.each(["withdrawn", "overturned"] as const)("refuses to withdraw a %s argument", async (status) => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "resolved" });
    const arg = await f.insertArgument(c.id, author.actor.agentId, status);
    expect(f.errorOf(await withdrawArgument(t.db, author.actor, arg.id))).toBe("illegal_transition");
  });

  it("answers not_found to other agents, including the case filer, and for bad ids", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "argued" });
    const arg = await f.insertArgument(c.id, author.actor.agentId, "active");
    expect(f.errorOf(await withdrawArgument(t.db, filer.actor, arg.id))).toBe("not_found");
    expect(f.errorOf(await withdrawArgument(t.db, (await f.makeAgent()).actor, arg.id))).toBe("not_found");
    expect(f.errorOf(await withdrawArgument(t.db, author.actor, "not-a-uuid"))).toBe("not_found");
    expect(f.errorOf(await withdrawArgument(t.db, author.actor, crypto.randomUUID()))).toBe("not_found");
    expect(await argumentStatusOf(arg.id)).toBe("active");
  });

  it("is backed by a database rule that also refuses won to withdrawn", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "resolved" });
    const won = await f.insertArgument(c.id, author.actor.agentId, "won");
    await expect(t.sql(`update arguments set status = 'withdrawn' where id = $1`, [won.id])).rejects.toMatchObject({
      code: "23514",
    });
  });
});

describe("publishHeldArgument", () => {
  it("activates a held argument and moves an open case to argued", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const { argument } = f.unwrap(await submitArgument(t.db, failClosedGate, author.actor, c.id, fix));
    expect(f.unwrap(await publishHeldArgument(t.db, argument.id)).status).toBe("active");
    expect(await caseStatusOf(c.id)).toBe("argued");
  });

  it("leaves an argued case argued", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "argued" });
    const held = await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "held");
    f.unwrap(await publishHeldArgument(t.db, held.id));
    expect(await caseStatusOf(c.id)).toBe("argued");
  });

  it("refuses an argument that is not held, or whose case is no longer open or argued", async () => {
    const filer = await f.makeAgent();
    const open = await f.insertCase(filer.actor.agentId, { status: "open" });
    const gone = await f.insertCase(filer.actor.agentId, { status: "withdrawn" });
    const active = await f.insertArgument(open.id, (await f.makeAgent()).actor.agentId, "active");
    const orphan = await f.insertArgument(gone.id, (await f.makeAgent()).actor.agentId, "held");
    expect(f.errorOf(await publishHeldArgument(t.db, active.id))).toBe("illegal_transition");
    expect(f.errorOf(await publishHeldArgument(t.db, orphan.id))).toBe("illegal_transition");
    expect(f.errorOf(await publishHeldArgument(t.db, crypto.randomUUID()))).toBe("not_found");
    expect(f.errorOf(await publishHeldArgument(t.db, "not-a-uuid"))).toBe("not_found");
  });
});

describe("submitArgument: redaction summary (AC-414)", () => {
  const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

  it("redacts a secret in the argument, stores the redacted text and reports the count", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const result = f.unwrap(
      await submitArgument(t.db, createGate(), author.actor, c.id, {
        reasoning: `The loop has no exit, and the old build printed ${awsKey} in its log, which should be rotated.`,
        proposed_change: "Set max_retries to 1.",
      }),
    );
    expect(result.held).toBe(false);
    expect(result.argument.reasoning).toContain("[REDACTED:aws_access_key]");
    expect(result.argument.reasoning).not.toContain(awsKey);
    expect(result.redactions).toEqual({ total: 1, types: { aws_access_key: 1 } });
  });

  it("reports zero redactions when nothing was redacted", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const result = f.unwrap(await submitArgument(t.db, passGate, author.actor, c.id, fix));
    expect(result.redactions).toEqual({ total: 0, types: {} });
  });
});

describe("rejectHeldArgument (AC-409)", () => {
  it("rejects a held argument and leaves an open case open", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const { argument } = f.unwrap(await submitArgument(t.db, failClosedGate, author.actor, c.id, fix));
    expect(f.unwrap(await rejectHeldArgument(t.db, argument.id)).status).toBe("rejected");
    expect(await argumentStatusOf(argument.id)).toBe("rejected");
    expect(await caseStatusOf(c.id)).toBe("open");
  });

  it("leaves an argued case argued", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "argued" });
    await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "active");
    const held = await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "held");
    f.unwrap(await rejectHeldArgument(t.db, held.id));
    expect(await caseStatusOf(c.id)).toBe("argued");
  });

  it("rejects a held argument even when its case has since been withdrawn", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "withdrawn" });
    const held = await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "held");
    expect(f.unwrap(await rejectHeldArgument(t.db, held.id)).status).toBe("rejected");
  });

  it("frees the author's place, so the same agent can argue again", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const first = f.unwrap(await submitArgument(t.db, failClosedGate, author.actor, c.id, fix));
    expect(f.errorOf(await submitArgument(t.db, passGate, author.actor, c.id, fix))).toBe("already_argued");
    f.unwrap(await rejectHeldArgument(t.db, first.argument.id));
    const second = f.unwrap(await submitArgument(t.db, passGate, author.actor, c.id, fix));
    expect(second.argument.status).toBe("active");
    expect(second.caseStatus).toBe("argued");
  });

  it.each(["active", "withdrawn", "won", "rejected"] as const)("refuses a %s argument and changes nothing", async (status) => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const a = await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, status);
    expect(f.errorOf(await rejectHeldArgument(t.db, a.id))).toBe("illegal_transition");
    expect(await argumentStatusOf(a.id)).toBe(status);
  });

  it("answers not_found for unknown ids and for ids that are not UUIDs", async () => {
    expect(f.errorOf(await rejectHeldArgument(t.db, crypto.randomUUID()))).toBe("not_found");
    expect(f.errorOf(await rejectHeldArgument(t.db, "not-a-uuid"))).toBe("not_found");
  });

  it("hides a rejected argument from other agents and still shows it to its author", async () => {
    const filer = await f.makeAgent();
    const author = await f.makeAgent();
    const viewer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const held = await f.insertArgument(c.id, author.actor.agentId, "held");
    f.unwrap(await rejectHeldArgument(t.db, held.id));
    expect((await getCase(t.db, viewer.actor.agentId, c.id))?.arguments).toEqual([]);
    expect((await getCase(t.db, filer.actor.agentId, c.id))?.arguments).toEqual([]);
    expect((await getCase(t.db, author.actor.agentId, c.id))?.arguments.map((entry) => entry.argument.status)).toEqual(["rejected"]);
  });
});
