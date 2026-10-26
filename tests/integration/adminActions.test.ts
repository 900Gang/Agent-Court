import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { argumentsTable, cases, evidence as evidenceTable, operators, type Operator } from "@/db/schema";
import { moderateCore } from "@/lib/admin/actionsCore";
import type { ActionDeps } from "@/lib/dashboard/actionsCore";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
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

async function makeOperator(
  role: "operator" | "admin" = "admin",
  status: "active" | "pending" | "suspended" = "active",
): Promise<Operator> {
  const [row] = await t.db
    .insert(operators)
    .values({ githubId: f.uniq("gh"), displayName: "Operator", role, status })
    .returning();
  return row;
}

const deps = (operator: Operator | null, over: Partial<ActionDeps> = {}): ActionDeps => ({
  db: t.db,
  operator,
  headers: new Headers({ origin: ORIGIN }),
  expectedOrigin: ORIGIN,
  ...over,
});
const crossSite = { headers: new Headers({ origin: "https://evil.example" }) };
const noOrigin = { headers: new Headers() };

type Kind = "case" | "evidence" | "argument";
const decide = (operator: Operator | null, kind: Kind, id: string, decision: "approve" | "reject", over: Partial<ActionDeps> = {}) =>
  moderateCore(deps(operator, over), { kind, id, decision });

function codeOf(result: { ok: boolean; error?: { code: string } }): string {
  if (result.ok) throw new Error("expected a failure");
  return result.error?.code ?? "";
}

async function caseStatus(id: string) {
  return (await t.db.select().from(cases).where(eq(cases.id, id)))[0].status;
}
async function evidenceStatus(id: string) {
  return (await t.db.select().from(evidenceTable).where(eq(evidenceTable.id, id)))[0].status;
}
async function argumentStatus(id: string) {
  return (await t.db.select().from(argumentsTable).where(eq(argumentsTable.id, id)))[0].status;
}

const auditRows = (target: string) => f.count("audit_log where action like 'moderation.%' and target = $1", [target]);
const eventRows = (target: string) => f.count(`moderation_events where "check" = 'manual' and target_id = $1`, [target]);

async function heldCase() {
  const filer = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { status: "held" });
  const e = await f.insertEvidence(c.id, "held");
  return { filer, c, e };
}

describe("moderateCore: who may act (AC-410)", () => {
  it.each([
    ["a different origin", crossSite],
    ["no origin", noOrigin],
  ])("refuses %s before anything else, even for an admin", async (_label, over) => {
    const admin = await makeOperator();
    const { c } = await heldCase();
    expect(codeOf(await decide(admin, "case", c.id, "approve", over))).toBe("origin_mismatch");
    expect(codeOf(await decide(null, "case", c.id, "approve", over))).toBe("origin_mismatch");
    expect(await caseStatus(c.id)).toBe("held");
    expect(await auditRows(c.id)).toBe(0);
  });

  it("answers anyone who is not an active admin exactly as it answers a missing sign-in, and changes nothing", async () => {
    const deleted = { ...(await makeOperator()), deletedAt: new Date("2026-10-20T00:00:00Z") };
    const who: Array<[string, Operator | null]> = [
      ["nobody", null],
      ["an ordinary operator", await makeOperator("operator")],
      ["a pending admin", await makeOperator("admin", "pending")],
      ["a suspended admin", await makeOperator("admin", "suspended")],
      ["a deleted admin", deleted],
    ];
    const { c, e } = await heldCase();
    const answers = new Set<string>();
    for (const [label, operator] of who) {
      const result = await decide(operator, "case", c.id, "approve");
      expect(codeOf(result), label).toBe("not_signed_in");
      answers.add(JSON.stringify(result));
    }
    expect(answers.size).toBe(1);
    expect(await caseStatus(c.id)).toBe("held");
    expect(await evidenceStatus(e.id)).toBe("held");
    expect(await auditRows(c.id)).toBe(0);
    expect(await eventRows(c.id)).toBe(0);
  });
});

describe("moderateCore: decisions", () => {
  it("approves a held case, which opens it and activates its held evidence", async () => {
    const admin = await makeOperator();
    const { c, e } = await heldCase();
    const result = await decide(admin, "case", c.id, "approve");
    expect(result).toEqual({ ok: true, value: { status: "open" } });
    expect(await caseStatus(c.id)).toBe("open");
    expect(await evidenceStatus(e.id)).toBe("active");
  });

  it("rejects a held case, which rejects its held evidence", async () => {
    const admin = await makeOperator();
    const { c, e } = await heldCase();
    expect(await decide(admin, "case", c.id, "reject")).toEqual({ ok: true, value: { status: "rejected" } });
    expect(await caseStatus(c.id)).toBe("rejected");
    expect(await evidenceStatus(e.id)).toBe("rejected");
  });

  it("approves and rejects held evidence on a public case", async () => {
    const admin = await makeOperator();
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const first = await f.insertEvidence(c.id, "held");
    const second = await f.insertEvidence(c.id, "held");
    expect(await decide(admin, "evidence", first.id, "approve")).toEqual({ ok: true, value: { status: "active" } });
    expect(await decide(admin, "evidence", second.id, "reject")).toEqual({ ok: true, value: { status: "rejected" } });
    expect(await evidenceStatus(first.id)).toBe("active");
    expect(await evidenceStatus(second.id)).toBe("rejected");
  });

  it("approves and rejects held arguments", async () => {
    const admin = await makeOperator();
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const first = await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "held");
    const second = await f.insertArgument(c.id, (await f.makeAgent()).actor.agentId, "held");
    expect(await decide(admin, "argument", first.id, "approve")).toEqual({ ok: true, value: { status: "active" } });
    expect(await caseStatus(c.id)).toBe("argued");
    expect(await decide(admin, "argument", second.id, "reject")).toEqual({ ok: true, value: { status: "rejected" } });
    expect(await argumentStatus(second.id)).toBe("rejected");
  });
});

describe("moderateCore: the record it leaves", () => {
  it("writes one audit row and one manual moderation event for an approval", async () => {
    const admin = await makeOperator();
    const { c } = await heldCase();
    await decide(admin, "case", c.id, "approve");
    const audit = await t.sql(`select action, actor_type, actor_id, target, metadata from audit_log where target = $1`, [c.id]);
    expect(audit).toEqual([
      { action: "moderation.approved", actor_type: "operator", actor_id: admin.id, target: c.id, metadata: { kind: "case" } },
    ]);
    const events = await t.sql(
      `select target_type, result, details from moderation_events where "check" = 'manual' and target_id = $1`,
      [c.id],
    );
    expect(events).toEqual([{ target_type: "case", result: "pass", details: { action: "approve" } }]);
  });

  it("writes one audit row and one manual moderation event for a rejection", async () => {
    const admin = await makeOperator();
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const e = await f.insertEvidence(c.id, "held");
    await decide(admin, "evidence", e.id, "reject");
    const audit = await t.sql(`select action, metadata from audit_log where target = $1`, [e.id]);
    expect(audit).toEqual([{ action: "moderation.rejected", metadata: { kind: "evidence" } }]);
    const events = await t.sql(
      `select target_type, result, details from moderation_events where "check" = 'manual' and target_id = $1`,
      [e.id],
    );
    expect(events).toEqual([{ target_type: "evidence", result: "block", details: { action: "reject" } }]);
  });

  it("answers illegal_transition to a repeated action and writes no second row", async () => {
    const admin = await makeOperator();
    const { c } = await heldCase();
    expect((await decide(admin, "case", c.id, "approve")).ok).toBe(true);
    expect(codeOf(await decide(admin, "case", c.id, "approve"))).toBe("illegal_transition");
    expect(codeOf(await decide(admin, "case", c.id, "reject"))).toBe("illegal_transition");
    expect(await auditRows(c.id)).toBe(1);
    expect(await eventRows(c.id)).toBe(1);
  });

  it("answers not_found for unknown and non-UUID ids, and writes nothing", async () => {
    const admin = await makeOperator();
    const before = await f.count("audit_log where action like 'moderation.%'");
    for (const kind of ["case", "evidence", "argument"] as const) {
      expect(codeOf(await decide(admin, kind, crypto.randomUUID(), "approve"))).toBe("not_found");
      expect(codeOf(await decide(admin, kind, "not-a-uuid", "reject"))).toBe("not_found");
    }
    expect(await f.count("audit_log where action like 'moderation.%'")).toBe(before);
  });

  it("refuses an unknown kind or decision as invalid input", async () => {
    const admin = await makeOperator();
    const { c } = await heldCase();
    expect(codeOf(await decide(admin, "report" as never, c.id, "approve"))).toBe("invalid");
    expect(codeOf(await decide(admin, "case", c.id, "delete" as never))).toBe("invalid");
    expect(await caseStatus(c.id)).toBe("held");
  });

  it("uses fixed message text for the failures it reports", async () => {
    const admin = await makeOperator();
    const { c } = await heldCase();
    await decide(admin, "case", c.id, "approve");
    const again = await decide(admin, "case", c.id, "approve");
    expect(!again.ok && again.error.message.length).toBeGreaterThan(0);
    expect(JSON.stringify(again)).not.toContain(c.id);
  });
});
