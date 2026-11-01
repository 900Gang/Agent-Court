import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operators, type Operator } from "@/db/schema";
import type { ActionDeps, ActionResult } from "@/lib/dashboard/actionsCore";
import { describeError } from "@/lib/dashboard/messages";
import { issueVerdictCore, verdictRedirect } from "@/lib/dashboard/verdictCore";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const ORIGIN = "http://localhost:3000";
const NOW = new Date("2026-10-28T12:00:00.000Z");
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

const deps = (operator: Operator | null, over: Partial<ActionDeps> = {}): ActionDeps => ({
  db: t.db,
  operator,
  headers: new Headers({ origin: ORIGIN }),
  expectedOrigin: ORIGIN,
  now: NOW,
  ...over,
});
const crossSite = { headers: new Headers({ origin: "https://evil.example" }) };
const noOrigin = { headers: new Headers() };

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) data.append(name, value);
  return data;
}

function codeOf(result: { ok: boolean; error?: { code: string } }): string {
  if (result.ok) throw new Error("expected a failure");
  return result.error?.code ?? "";
}

/** An open case filed by the operator under test, with one active argument from another operator's agent. */
async function openCase() {
  const filer = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { status: "open" });
  const rival = await f.makeAgent();
  const argument = await f.insertArgument(c.id, rival.actor.agentId, "active");
  return { filer, c, rival, argument };
}

async function snapshot(caseId: string) {
  return {
    verdicts: await f.count("verdicts where case_id = $1", [caseId]),
    events: await f.count("reputation_events"),
    status: (await t.sql(`select status from cases where id = $1`, [caseId]))[0].status as string,
  };
}

describe("issueVerdictCore: who may act", () => {
  it.each([
    ["a different origin", crossSite],
    ["no origin", noOrigin],
  ])("refuses %s before anything else, signed in or not, and writes nothing", async (_label, over) => {
    const { filer, c, argument } = await openCase();
    const before = await snapshot(c.id);
    for (const who of [filer.operator, null]) {
      const result = await issueVerdictCore(deps(who, over), form({ caseId: c.id, winningArgumentId: argument.id }));
      expect(codeOf(result)).toBe("origin_mismatch");
    }
    expect(await snapshot(c.id)).toEqual(before);
  });

  it("refuses a visitor who is not signed in", async () => {
    const { c, argument } = await openCase();
    expect(codeOf(await issueVerdictCore(deps(null), form({ caseId: c.id, winningArgumentId: argument.id })))).toBe("not_signed_in");
  });

  it.each(["pending", "suspended"] as const)("refuses a %s operator", async (status) => {
    const [operator] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Op", status }).returning();
    const { c, argument } = await openCase();
    const before = await snapshot(c.id);
    expect(codeOf(await issueVerdictCore(deps(operator), form({ caseId: c.id, winningArgumentId: argument.id })))).toBe("operator_not_active");
    expect(await snapshot(c.id)).toEqual(before);
  });
});

describe("issueVerdictCore: what it refuses", () => {
  it("answers case_not_found for an unknown case and for another operator's case, the same", async () => {
    const { c, argument } = await openCase();
    const stranger = await f.makeOperator();
    const before = await snapshot(c.id);
    expect(codeOf(await issueVerdictCore(deps(stranger), form({ caseId: c.id, winningArgumentId: argument.id })))).toBe("case_not_found");
    expect(codeOf(await issueVerdictCore(deps(stranger), form({ caseId: UNKNOWN, winningArgumentId: argument.id })))).toBe("case_not_found");
    expect(await snapshot(c.id)).toEqual(before);
  });

  it("answers case_not_open for a case that already has a verdict, and writes no second one", async () => {
    const { filer, c, argument } = await openCase();
    const first = await issueVerdictCore(deps(filer.operator), form({ caseId: c.id, winningArgumentId: argument.id }));
    expect(first.ok).toBe(true);
    const before = await snapshot(c.id);
    expect(codeOf(await issueVerdictCore(deps(filer.operator), form({ caseId: c.id, winningArgumentId: argument.id })))).toBe("case_not_open");
    expect(await snapshot(c.id)).toEqual(before);
  });

  it("answers winner_not_eligible for a withdrawn argument and for an argument of another case", async () => {
    const { filer, c, rival } = await openCase();
    const withdrawn = await f.insertArgument(c.id, rival.actor.agentId, "withdrawn");
    const elsewhere = await openCase();
    const before = await snapshot(c.id);
    expect(codeOf(await issueVerdictCore(deps(filer.operator), form({ caseId: c.id, winningArgumentId: withdrawn.id })))).toBe("winner_not_eligible");
    expect(codeOf(await issueVerdictCore(deps(filer.operator), form({ caseId: c.id, winningArgumentId: elsewhere.argument.id })))).toBe("winner_not_eligible");
    expect(await snapshot(c.id)).toEqual(before);
  });

  it("answers invalid with the field named when the winner is missing or the note is too long", async () => {
    const { filer, c, argument } = await openCase();
    const before = await snapshot(c.id);
    const missing = await issueVerdictCore(deps(filer.operator), form({ caseId: c.id }));
    expect(codeOf(missing)).toBe("invalid");
    expect(missing.ok === false && missing.fieldErrors).toHaveProperty("winningArgumentId");
    const long = await issueVerdictCore(deps(filer.operator), form({ caseId: c.id, winningArgumentId: argument.id, note: "x".repeat(501) }));
    expect(codeOf(long)).toBe("invalid");
    expect(long.ok === false && long.fieldErrors).toHaveProperty("note");
    expect(await snapshot(c.id)).toEqual(before);
  });

  it("never puts what was submitted into the answer", async () => {
    const { filer } = await openCase();
    const result = await issueVerdictCore(deps(filer.operator), form({ caseId: "<script>alert(1)</script>", winningArgumentId: "<img src=x onerror=alert(1)>", note: "<b>x</b>" }));
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("<img");
    expect(text).not.toContain("<b>");
  });
});

describe("issueVerdictCore: what it does", () => {
  it("records a verdict for another operator's agent and answers what it was worth", async () => {
    const { filer, c, rival, argument } = await openCase();
    const result = await issueVerdictCore(deps(filer.operator), form({ caseId: c.id, winningArgumentId: argument.id, note: "The cap fixed it." }));
    expect(result).toEqual({
      ok: true,
      value: { caseId: c.id, level: "operator_confirmed", points: 10, releaseAt: "2026-11-04T12:00:00.000Z" },
    });
    const [verdict] = await t.sql(`select note, verification_level, status from verdicts where case_id = $1`, [c.id]);
    expect(verdict).toMatchObject({ note: "The cap fixed it.", verification_level: "operator_confirmed", status: "active" });
    const [event] = await t.sql(`select agent_id, points, status from reputation_events where verdict_id = (select id from verdicts where case_id = $1)`, [c.id]);
    expect(event).toMatchObject({ agent_id: rival.actor.agentId, points: 10, status: "pending" });
    expect((await snapshot(c.id)).status).toBe("resolved");
  });

  it("records a self-resolved verdict with no points when the winner belongs to the same operator", async () => {
    const filer = await f.makeAgent();
    const own = await f.makeAgent(filer.operator);
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const argument = await f.insertArgument(c.id, own.actor.agentId, "active");
    const before = await f.count("reputation_events");
    const result = await issueVerdictCore(deps(filer.operator), form({ caseId: c.id, winningArgumentId: argument.id }));
    expect(result).toEqual({ ok: true, value: { caseId: c.id, level: "self_resolved", points: 0, releaseAt: null } });
    expect(await f.count("reputation_events")).toBe(before);
  });

  it("stores no note when the note is blank", async () => {
    const { filer, c, argument } = await openCase();
    await issueVerdictCore(deps(filer.operator), form({ caseId: c.id, winningArgumentId: argument.id, note: "   " }));
    expect((await t.sql(`select note from verdicts where case_id = $1`, [c.id]))[0].note).toBeNull();
  });
});

describe("the messages for the new codes", () => {
  it.each(["case_not_found", "case_not_open", "winner_not_eligible"])("%s has its own fixed message and hint", (code) => {
    const error = describeError(code);
    expect(error.code).toBe(code);
    expect(error.message.length).toBeGreaterThan(10);
    expect(error.hint.length).toBeGreaterThan(10);
  });
});

describe("verdictRedirect", () => {
  const ok = (level: "operator_confirmed" | "self_resolved"): ActionResult<{ caseId: string; level: string; points: number; releaseAt: string | null }> => ({
    ok: true,
    value: { caseId: UNKNOWN, level, points: 0, releaseAt: null },
  });
  const failed = (code: string): ActionResult<never> => ({ ok: false, error: { code, message: "m", hint: "h" } });

  it("sends a confirmed verdict to the list with a fixed word, and a self-resolved one with another", () => {
    expect(verdictRedirect(ok("operator_confirmed"), UNKNOWN)).toBe("/dashboard/cases?verdict=ok");
    expect(verdictRedirect(ok("self_resolved"), UNKNOWN)).toBe("/dashboard/cases?verdict=self_resolved");
  });

  it("sends a refusal back to the form of the case that was submitted, when that is a UUID", () => {
    expect(verdictRedirect(failed("case_not_open"), UNKNOWN)).toBe(`/dashboard/cases/${UNKNOWN}/verdict?error=case_not_open`);
  });

  it("sends a refusal to the list when the submitted case id is not a UUID", () => {
    expect(verdictRedirect(failed("invalid"), "nope")).toBe("/dashboard/cases?error=invalid");
  });

  it("encodes the error code", () => {
    expect(verdictRedirect(failed("x y&z"), "")).toBe("/dashboard/cases?error=x%20y%26z");
  });

  it("cannot be turned into a path off the site by a forged case id", () => {
    const forged = ["", "//evil.example", "https://evil.example/x", "/\\evil.example", "../../etc", "javascript:alert(1)", `${UNKNOWN}/../../x`, `${UNKNOWN}?x=1`, `${UNKNOWN}\n`, "%2F%2Fevil.example"];
    for (const value of forged) {
      expect(verdictRedirect(failed("invalid"), value), JSON.stringify(value)).toBe("/dashboard/cases?error=invalid");
    }
    for (const value of [UNKNOWN, ...forged]) {
      expect(verdictRedirect(failed("invalid"), value)).toMatch(/^\/dashboard\/cases(\/[0-9a-f-]{36}\/verdict)?\?error=[A-Za-z0-9_%]+$/);
    }
  });
});
