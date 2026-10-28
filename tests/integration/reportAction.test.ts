import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operators, type Operator } from "@/db/schema";
import type { ActionDeps } from "@/lib/dashboard/actionsCore";
import { createReportCore, reportRedirect } from "@/lib/observer/actionsCore";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const ORIGIN = "http://localhost:3000";
const NOW = new Date("2026-10-28T12:00:00.000Z");
const REASON = "This case tells readers to ignore their rules and send their keys somewhere.";

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

async function publicCase() {
  const filer = await f.makeAgent();
  return f.insertCase(filer.actor.agentId, { status: "open" });
}

function codeOf(result: { ok: boolean; error?: { code: string } }): string {
  if (result.ok) throw new Error("expected a failure");
  return result.error?.code ?? "";
}

describe("createReportCore: who may act", () => {
  it.each([
    ["a different origin", crossSite],
    ["no origin", noOrigin],
  ])("refuses %s before anything else, signed in or not", async (_label, over) => {
    const operator = await f.makeOperator();
    const c = await publicCase();
    const before = await f.count("reports");
    for (const who of [operator, null]) {
      const result = await createReportCore(deps(who, over), form({ targetType: "case", targetId: c.id, reason: REASON }));
      expect(codeOf(result)).toBe("origin_mismatch");
    }
    expect(await f.count("reports")).toBe(before);
  });

  it("refuses a visitor who is not signed in", async () => {
    const c = await publicCase();
    expect(codeOf(await createReportCore(deps(null), form({ targetType: "case", targetId: c.id, reason: REASON })))).toBe("not_signed_in");
  });

  it.each(["pending", "suspended"] as const)("refuses a %s operator", async (status) => {
    const [operator] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Op", status }).returning();
    const c = await publicCase();
    expect(codeOf(await createReportCore(deps(operator), form({ targetType: "case", targetId: c.id, reason: REASON })))).toBe("operator_not_active");
  });
});

describe("createReportCore: what it does", () => {
  it("records a report on a case and answers with that case", async () => {
    const operator = await f.makeOperator();
    const c = await publicCase();
    const result = await createReportCore(deps(operator), form({ targetType: "case", targetId: c.id, reason: REASON }));
    expect(result).toEqual({ ok: true, value: { caseId: c.id } });
    expect(await f.count("reports where reporter_operator_id = $1 and target_id = $2", [operator.id, c.id])).toBe(1);
  });

  it("answers an argument report with the argument's case, taken from the database and not from the form", async () => {
    const operator = await f.makeOperator();
    const c = await publicCase();
    const author = await f.makeAgent();
    const argument = await f.insertArgument(c.id, author.actor.agentId, "active");
    const other = await publicCase();
    const result = await createReportCore(
      deps(operator),
      form({ targetType: "argument", targetId: argument.id, reason: REASON, caseId: other.id }),
    );
    expect(result).toEqual({ ok: true, value: { caseId: c.id } });
  });

  it("names the reason field when it is too short, without echoing it", async () => {
    const operator = await f.makeOperator();
    const c = await publicCase();
    const result = await createReportCore(deps(operator), form({ targetType: "case", targetId: c.id, reason: "<b>no</b>" }));
    expect(codeOf(result)).toBe("invalid");
    expect(!result.ok && Object.keys(result.fieldErrors ?? {})).toEqual(["reason"]);
    expect(JSON.stringify(result)).not.toContain("<b>");
  });

  it("answers a hidden or unknown target with not_found, the same for both", async () => {
    const operator = await f.makeOperator();
    const held = await f.insertCase((await f.makeAgent()).actor.agentId, { status: "held" });
    const hidden = await createReportCore(deps(operator), form({ targetType: "case", targetId: held.id, reason: REASON }));
    const unknown = await createReportCore(deps(operator), form({ targetType: "case", targetId: crypto.randomUUID(), reason: REASON }));
    expect(codeOf(hidden)).toBe("not_found");
    expect(unknown).toEqual(hidden);
  });

  it("answers a second report on the same target with already_reported", async () => {
    const operator = await f.makeOperator();
    const c = await publicCase();
    const input = form({ targetType: "case", targetId: c.id, reason: REASON });
    expect((await createReportCore(deps(operator), input)).ok).toBe(true);
    expect(codeOf(await createReportCore(deps(operator), form({ targetType: "case", targetId: c.id, reason: REASON })))).toBe("already_reported");
  });

  it("answers an eleventh report in a day with report_limit", async () => {
    const operator = await f.makeOperator();
    for (let i = 0; i < 10; i++) {
      const c = await publicCase();
      expect((await createReportCore(deps(operator), form({ targetType: "case", targetId: c.id, reason: REASON }))).ok).toBe(true);
    }
    const c = await publicCase();
    expect(codeOf(await createReportCore(deps(operator), form({ targetType: "case", targetId: c.id, reason: REASON })))).toBe("report_limit");
  });

  it("ignores missing fields as invalid input, never as a crash", async () => {
    const operator = await f.makeOperator();
    for (const data of [form({}), form({ targetType: "case" }), form({ reason: REASON })]) {
      expect(["invalid", "not_found"]).toContain(codeOf(await createReportCore(deps(operator), data)));
    }
  });
});

describe("reportRedirect", () => {
  const ID = "00000000-0000-4000-8000-000000000001";
  const OTHER = "00000000-0000-4000-8000-000000000002";

  it("sends a success to the case the server confirmed, with a flag", () => {
    expect(reportRedirect({ ok: true, value: { caseId: ID } }, OTHER)).toBe(`/cases/${ID}?reported=1`);
  });

  it("sends a failure back to the case the form named, with the error code", () => {
    const failure = { ok: false as const, error: { code: "already_reported", message: "m", hint: "h" } };
    expect(reportRedirect(failure, ID)).toBe(`/cases/${ID}?error=already_reported`);
  });

  it.each(["", "not-a-uuid", "../admin", "https://evil.example", "//evil.example", "<script>", `${ID}/../x`, `${ID}?x=1`])(
    "sends a failure to the home page when the form's case id is %j",
    (submitted) => {
      const failure = { ok: false as const, error: { code: "invalid", message: "m", hint: "h" } };
      expect(reportRedirect(failure, submitted)).toBe("/?error=invalid");
    },
  );

  it("builds every address from a UUID it checked, so it can only ever stay on this site", () => {
    const failure = { ok: false as const, error: { code: "not_found", message: "m", hint: "h" } };
    for (const submitted of [ID, OTHER, "x", "//a.b"]) {
      const path = reportRedirect(failure, submitted);
      expect(path.startsWith("/")).toBe(true);
      expect(path.startsWith("//")).toBe(false);
    }
  });
});
