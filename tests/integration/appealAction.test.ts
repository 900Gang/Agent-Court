import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operators, type Operator } from "@/db/schema";
import { appealCore, appealRedirect } from "@/lib/dashboard/appealCore";
import type { ActionDeps, ActionResult } from "@/lib/dashboard/actionsCore";
import { describeError } from "@/lib/dashboard/messages";
import { issueVerdict } from "@/lib/services/verdictService";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const ORIGIN = "http://localhost:3000";
const NOW = new Date("2026-10-31T12:00:00.000Z");
const DAY = 86_400_000;
const LATER = new Date(NOW.getTime() + DAY);
const REASON = "The fix did not hold: the loop returned on the second run.";
const aws = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
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
  now: LATER,
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

async function resolvedCase() {
  const filer = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { status: "open" });
  const winner = await f.makeAgent();
  const argument = await f.insertArgument(c.id, winner.actor.agentId, "active");
  const issued = f.unwrap(await issueVerdict(t.db, passGate, filer.operator, { caseId: c.id, winningArgumentId: argument.id }, NOW));
  return { filer, c, verdictId: issued.verdictId };
}

async function snapshot(caseId: string) {
  return {
    verdict: await t.sql(`select status, appealed_at, appeal_reason from verdicts where case_id = $1`, [caseId]),
    status: (await t.sql(`select status from cases where id = $1`, [caseId]))[0].status as string,
    audit: await f.count("audit_log where action = 'appeal.filed'"),
  };
}

describe("appealCore: who may act", () => {
  it.each([
    ["a different origin", crossSite],
    ["no origin", noOrigin],
  ])("refuses %s before anything else, signed in or not, and writes nothing", async (_label, over) => {
    const s = await resolvedCase();
    const before = await snapshot(s.c.id);
    for (const who of [s.filer.operator, null]) {
      expect(codeOf(await appealCore(deps(who, over), form({ caseId: s.c.id, reason: REASON })))).toBe("origin_mismatch");
    }
    expect(await snapshot(s.c.id)).toEqual(before);
  });

  it("refuses a visitor who is not signed in", async () => {
    const s = await resolvedCase();
    expect(codeOf(await appealCore(deps(null), form({ caseId: s.c.id, reason: REASON })))).toBe("not_signed_in");
  });

  it.each(["pending", "suspended"] as const)("refuses a %s operator", async (status) => {
    const s = await resolvedCase();
    const [operator] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Op", status }).returning();
    const before = await snapshot(s.c.id);
    expect(codeOf(await appealCore(deps(operator), form({ caseId: s.c.id, reason: REASON })))).toBe("operator_not_active");
    expect(await snapshot(s.c.id)).toEqual(before);
  });
});

describe("appealCore: what it refuses", () => {
  it("answers case_not_found for an unknown case and for another operator's case", async () => {
    const s = await resolvedCase();
    const stranger = await f.makeOperator();
    const before = await snapshot(s.c.id);
    expect(codeOf(await appealCore(deps(stranger), form({ caseId: s.c.id, reason: REASON })))).toBe("case_not_found");
    expect(codeOf(await appealCore(deps(stranger), form({ caseId: UNKNOWN, reason: REASON })))).toBe("case_not_found");
    expect(await snapshot(s.c.id)).toEqual(before);
  });

  it("answers case_not_resolved for a case with no verdict to appeal", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    expect(codeOf(await appealCore(deps(filer.operator), form({ caseId: c.id, reason: REASON })))).toBe("case_not_resolved");
  });

  it("answers already_appealed for a second appeal, and appeal_window_closed after seven days", async () => {
    const s = await resolvedCase();
    expect((await appealCore(deps(s.filer.operator), form({ caseId: s.c.id, reason: REASON }))).ok).toBe(true);
    const before = await snapshot(s.c.id);
    expect(codeOf(await appealCore(deps(s.filer.operator), form({ caseId: s.c.id, reason: REASON })))).toBe("already_appealed");
    expect(await snapshot(s.c.id)).toEqual(before);

    const late = await resolvedCase();
    const lateBefore = await snapshot(late.c.id);
    const result = await appealCore(deps(late.filer.operator, { now: new Date(NOW.getTime() + 8 * DAY) }), form({ caseId: late.c.id, reason: REASON }));
    expect(codeOf(result)).toBe("appeal_window_closed");
    expect(await snapshot(late.c.id)).toEqual(lateBefore);
  });

  it("answers invalid with the field named for a short reason, and writes nothing", async () => {
    const s = await resolvedCase();
    const before = await snapshot(s.c.id);
    const result = await appealCore(deps(s.filer.operator), form({ caseId: s.c.id, reason: "short" }));
    expect(codeOf(result)).toBe("invalid");
    expect(result.ok === false && result.fieldErrors).toHaveProperty("reason");
    expect(await snapshot(s.c.id)).toEqual(before);
  });

  it("never puts what was submitted into the answer", async () => {
    const { filer } = await resolvedCase();
    const result = await appealCore(deps(filer.operator), form({ caseId: "<script>alert(1)</script>", reason: "<img src=x onerror=alert(1)>" }));
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("<img");
  });
});

describe("appealCore: what it does", () => {
  it("files the appeal and answers with the case", async () => {
    const s = await resolvedCase();
    const result = await appealCore(deps(s.filer.operator), form({ caseId: s.c.id, reason: REASON }));
    expect(result).toEqual({ ok: true, value: { caseId: s.c.id } });
    const [verdict] = await t.sql(`select status, appeal_reason, appealed_at from verdicts where id = $1`, [s.verdictId]);
    expect(verdict).toMatchObject({ status: "under_appeal", appeal_reason: REASON });
    expect(new Date(verdict.appealed_at as string).getTime()).toBe(LATER.getTime());
    expect((await snapshot(s.c.id)).status).toBe("under_appeal");
  });

  it("redacts a secret in the reason with the real gate", async () => {
    const s = await resolvedCase();
    await appealCore(deps(s.filer.operator), form({ caseId: s.c.id, reason: `The winner printed ${aws} in its log.` }));
    const [verdict] = await t.sql(`select appeal_reason from verdicts where id = $1`, [s.verdictId]);
    expect(verdict.appeal_reason).toContain("[REDACTED:aws_access_key]");
    expect(verdict.appeal_reason).not.toContain(aws);
  });
});

describe("the messages for the new codes", () => {
  it.each(["already_appealed", "appeal_window_closed", "case_not_resolved"])("%s has its own fixed message and hint", (code) => {
    const error = describeError(code);
    expect(error.code).toBe(code);
    expect(error.message.length).toBeGreaterThan(10);
    expect(error.hint.length).toBeGreaterThan(10);
  });
});

describe("appealRedirect", () => {
  const ok: ActionResult<{ caseId: string }> = { ok: true, value: { caseId: UNKNOWN } };
  const failed = (code: string): ActionResult<never> => ({ ok: false, error: { code, message: "m", hint: "h" } });

  it("sends a success to the list with a fixed word", () => {
    expect(appealRedirect(ok, UNKNOWN)).toBe("/dashboard/cases?appeal=ok");
  });

  it("sends a refusal back to the appeal form of the submitted case, when that is a UUID", () => {
    expect(appealRedirect(failed("already_appealed"), UNKNOWN)).toBe(`/dashboard/cases/${UNKNOWN}/appeal?error=already_appealed`);
  });

  it("sends a refusal to the list when the submitted case id is not a UUID, and encodes the code", () => {
    expect(appealRedirect(failed("invalid"), "nope")).toBe("/dashboard/cases?error=invalid");
    expect(appealRedirect(failed("x y&z"), "")).toBe("/dashboard/cases?error=x%20y%26z");
  });

  it("cannot be turned into a path off the site by a forged case id", () => {
    const forged = ["", "//evil.example", "https://evil.example/x", "/\\evil.example", "../../etc", "javascript:alert(1)", `${UNKNOWN}/../../x`, `${UNKNOWN}?x=1`, `${UNKNOWN}\n`, "%2F%2Fevil.example"];
    for (const value of forged) expect(appealRedirect(failed("invalid"), value), JSON.stringify(value)).toBe("/dashboard/cases?error=invalid");
    for (const value of [UNKNOWN, ...forged]) {
      expect(appealRedirect(failed("invalid"), value)).toMatch(/^\/dashboard\/cases(\/[0-9a-f-]{36}\/appeal)?\?error=[A-Za-z0-9_%]+$/);
    }
  });
});
