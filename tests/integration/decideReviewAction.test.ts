import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operators, type Operator } from "@/db/schema";
import { decideReviewCore } from "@/lib/admin/reviewCore";
import type { ActionDeps } from "@/lib/dashboard/actionsCore";
import { describeError } from "@/lib/dashboard/messages";
import { appealVerdict, issueVerdict } from "@/lib/services/verdictService";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const ORIGIN = "http://localhost:3000";
const NOW = new Date("2026-10-31T12:00:00.000Z");
const DAY = 86_400_000;
const UNKNOWN = "00000000-0000-4000-8000-00000000dead";

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

async function makeOperator(role: "operator" | "admin" = "admin", status: "active" | "pending" | "suspended" = "active"): Promise<Operator> {
  const [row] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Operator", role, status }).returning();
  return row;
}

const deps = (operator: Operator | null, over: Partial<ActionDeps> = {}): ActionDeps => ({
  db: t.db,
  operator,
  headers: new Headers({ origin: ORIGIN }),
  expectedOrigin: ORIGIN,
  now: new Date(NOW.getTime() + 3 * DAY),
  ...over,
});
const crossSite = { headers: new Headers({ origin: "https://evil.example" }) };
const noOrigin = { headers: new Headers() };

const run = (operator: Operator | null, input: { caseId: string; decision: string }, over: Partial<ActionDeps> = {}) => decideReviewCore(deps(operator, over), input);

function codeOf(result: { ok: boolean; error?: { code: string } }): string {
  if (result.ok) throw new Error("expected a failure");
  return result.error?.code ?? "";
}

async function caseUnderAppeal() {
  const filer = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { status: "open" });
  const winner = await f.makeAgent();
  const argument = await f.insertArgument(c.id, winner.actor.agentId, "active");
  f.unwrap(await issueVerdict(t.db, passGate, filer.operator, { caseId: c.id, winningArgumentId: argument.id }, NOW));
  f.unwrap(await appealVerdict(t.db, passGate, filer.operator, { caseId: c.id, reason: "The fix did not hold on the second run." }, new Date(NOW.getTime() + DAY)));
  return { c };
}

async function snapshot(caseId: string) {
  return {
    case: (await t.sql(`select status from cases where id = $1`, [caseId]))[0].status as string,
    verdict: (await t.sql(`select status from verdicts where case_id = $1`, [caseId]))[0].status as string,
    audit: await f.count("audit_log where action in ('verdict.upheld', 'verdict.overturned')"),
  };
}

describe("decideReviewCore: who may act", () => {
  it.each([
    ["a different origin", crossSite],
    ["no origin", noOrigin],
  ])("refuses %s before anything else, even for an admin", async (_label, over) => {
    const admin = await makeOperator();
    const s = await caseUnderAppeal();
    const before = await snapshot(s.c.id);
    expect(codeOf(await run(admin, { caseId: s.c.id, decision: "overturn" }, over))).toBe("origin_mismatch");
    expect(codeOf(await run(null, { caseId: s.c.id, decision: "overturn" }, over))).toBe("origin_mismatch");
    expect(await snapshot(s.c.id)).toEqual(before);
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
    const s = await caseUnderAppeal();
    const before = await snapshot(s.c.id);
    const answers = new Set<string>();
    for (const [label, operator] of who) {
      const result = await run(operator, { caseId: s.c.id, decision: "overturn" });
      expect(codeOf(result), label).toBe("not_signed_in");
      answers.add(JSON.stringify(result));
    }
    expect(answers.size).toBe(1);
    expect(await snapshot(s.c.id)).toEqual(before);
  });
});

describe("decideReviewCore: what it does and refuses", () => {
  it("answers with the outcome for each decision", async () => {
    const admin = await makeOperator();
    const upheld = await caseUnderAppeal();
    expect(await run(admin, { caseId: upheld.c.id, decision: "uphold" })).toEqual({ ok: true, value: { outcome: "upheld" } });
    const overturned = await caseUnderAppeal();
    expect(await run(admin, { caseId: overturned.c.id, decision: "overturn" })).toEqual({ ok: true, value: { outcome: "overturned" } });
    // The only argument was the winner, so nothing active is left and the case goes back to open.
    expect(await snapshot(overturned.c.id)).toMatchObject({ case: "open", verdict: "overturned" });
  });

  it("answers review_not_found for an unknown case", async () => {
    expect(codeOf(await run(await makeOperator(), { caseId: UNKNOWN, decision: "uphold" }))).toBe("review_not_found");
  });

  it("answers review_not_open for a case that is not under review, and for one already decided", async () => {
    const admin = await makeOperator();
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    expect(codeOf(await run(admin, { caseId: c.id, decision: "uphold" }))).toBe("review_not_open");
    const s = await caseUnderAppeal();
    await run(admin, { caseId: s.c.id, decision: "uphold" });
    const before = await snapshot(s.c.id);
    expect(codeOf(await run(admin, { caseId: s.c.id, decision: "overturn" }))).toBe("review_not_open");
    expect(await snapshot(s.c.id)).toEqual(before);
  });

  it("answers invalid for a bad id or decision", async () => {
    const admin = await makeOperator();
    expect(codeOf(await run(admin, { caseId: "nope", decision: "uphold" }))).toBe("invalid");
    expect(codeOf(await run(admin, { caseId: UNKNOWN, decision: "approve" }))).toBe("invalid");
  });

  it("never puts what was submitted into the answer", async () => {
    const result = await run(await makeOperator(), { caseId: "<script>alert(1)</script>", decision: "<img src=x onerror=alert(1)>" });
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("<img");
  });
});

describe("the messages for the new codes", () => {
  it.each(["review_not_found", "review_not_open"])("%s has its own fixed message and hint", (code) => {
    const error = describeError(code);
    expect(error.code).toBe(code);
    expect(error.message.length).toBeGreaterThan(10);
    expect(error.hint.length).toBeGreaterThan(10);
  });
});
