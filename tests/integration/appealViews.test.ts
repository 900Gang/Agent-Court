import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAppealFormView, listOperatorCases } from "@/lib/services/operatorCaseService";
import { appealVerdict, issueVerdict } from "@/lib/services/verdictService";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const NOW = new Date("2026-10-31T12:00:00.000Z");
const DAY = 86_400_000;
const REASON = "The fix did not hold: the loop returned on the second run.";
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

async function resolvedCase() {
  const filer = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { status: "open", title: "MARK_title" });
  const winner = await f.makeAgent();
  const argument = await f.insertArgument(c.id, winner.actor.agentId, "active");
  const issued = f.unwrap(await issueVerdict(t.db, passGate, filer.operator, { caseId: c.id, winningArgumentId: argument.id }, NOW));
  return { filer, c, winner, argument, verdictId: issued.verdictId };
}

describe("listOperatorCases: the live verdict of each case", () => {
  it("is null for a case with no verdict", async () => {
    const filer = await f.makeAgent();
    await f.insertCase(filer.actor.agentId, { status: "open" });
    expect((await listOperatorCases(t.db, filer.operator.id)).cases[0].verdict).toBeNull();
  });

  it("gives the status, the date and whether it was appealed", async () => {
    const s = await resolvedCase();
    const [row] = (await listOperatorCases(t.db, s.filer.operator.id)).cases;
    expect(row.verdict).toEqual({ status: "active", createdAt: NOW, appealed: false });
    f.unwrap(await appealVerdict(t.db, passGate, s.filer.operator, { caseId: s.c.id, reason: REASON }, new Date(NOW.getTime() + DAY)));
    const [after] = (await listOperatorCases(t.db, s.filer.operator.id)).cases;
    expect(after.verdict).toEqual({ status: "under_appeal", createdAt: NOW, appealed: true });
  });

  it("leaves out an overturned verdict, and shows a case once when it has an old and a new one", async () => {
    const s = await resolvedCase();
    await t.sql(`update verdicts set status = 'overturned' where id = $1`, [s.verdictId]);
    await t.sql(`update arguments set status = 'overturned' where id = $1`, [s.argument.id]);
    await t.sql(`update cases set status = 'argued', resolved_at = null where id = $1`, [s.c.id]);
    expect((await listOperatorCases(t.db, s.filer.operator.id)).cases[0].verdict).toBeNull();

    const next = await f.makeAgent();
    const another = await f.insertArgument(s.c.id, next.actor.agentId, "active", new Date(NOW.getTime() + DAY));
    f.unwrap(await issueVerdict(t.db, passGate, s.filer.operator, { caseId: s.c.id, winningArgumentId: another.id }, new Date(NOW.getTime() + 2 * DAY)));
    const rows = (await listOperatorCases(t.db, s.filer.operator.id)).cases;
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toEqual({ status: "active", createdAt: new Date(NOW.getTime() + 2 * DAY), appealed: false });
  });

  it("keeps the argument counts right", async () => {
    const filer = await f.makeAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "argued" });
    const a = await f.makeAgent();
    const b = await f.makeAgent();
    await f.insertArgument(c.id, a.actor.agentId, "active");
    await f.insertArgument(c.id, b.actor.agentId, "active");
    expect((await listOperatorCases(t.db, filer.operator.id)).cases[0].argumentCount).toBe(2);
  });

  it("still sends the same few statements", async () => {
    const s = await resolvedCase();
    const spy = vi.spyOn(t.pg, "query");
    await listOperatorCases(t.db, s.filer.operator.id);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4);
    spy.mockRestore();
  });
});

describe("getAppealFormView", () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  it("gives the title, the verdict date and the deadline", async () => {
    const s = await resolvedCase();
    expect(await getAppealFormView(t.db, s.filer.operator.id, s.c.id, at(DAY))).toEqual({
      caseId: s.c.id,
      title: "MARK_title",
      verdictAt: NOW,
      deadline: at(7 * DAY),
    });
  });

  it("is available at exactly seven days and gone a millisecond later", async () => {
    const s = await resolvedCase();
    expect(await getAppealFormView(t.db, s.filer.operator.id, s.c.id, at(7 * DAY))).not.toBeNull();
    expect(await getAppealFormView(t.db, s.filer.operator.id, s.c.id, at(7 * DAY + 1))).toBeNull();
  });

  it("is null once appealed, and for a verdict under review from a report", async () => {
    const appealed = await resolvedCase();
    f.unwrap(await appealVerdict(t.db, passGate, appealed.filer.operator, { caseId: appealed.c.id, reason: REASON }, at(DAY)));
    expect(await getAppealFormView(t.db, appealed.filer.operator.id, appealed.c.id, at(DAY))).toBeNull();

    const reviewed = await resolvedCase();
    await t.sql(`update verdicts set status = 'under_appeal' where id = $1`, [reviewed.verdictId]);
    await t.sql(`update cases set status = 'under_appeal' where id = $1`, [reviewed.c.id]);
    expect(await getAppealFormView(t.db, reviewed.filer.operator.id, reviewed.c.id, at(DAY))).toBeNull();
  });

  it("is null for an overturned verdict, a case with no verdict, another operator's case and an unknown case", async () => {
    const overturned = await resolvedCase();
    await t.sql(`update verdicts set status = 'overturned' where id = $1`, [overturned.verdictId]);
    await t.sql(`update cases set status = 'argued' where id = $1`, [overturned.c.id]);
    expect(await getAppealFormView(t.db, overturned.filer.operator.id, overturned.c.id, at(DAY))).toBeNull();

    const open = await f.makeAgent();
    const c = await f.insertCase(open.actor.agentId, { status: "open" });
    expect(await getAppealFormView(t.db, open.operator.id, c.id, at(DAY))).toBeNull();

    const s = await resolvedCase();
    const stranger = await f.makeOperator();
    expect(await getAppealFormView(t.db, stranger.id, s.c.id, at(DAY))).toBeNull();
    expect(await getAppealFormView(t.db, stranger.id, UNKNOWN, at(DAY))).toBeNull();
  });

  it("is null for a malformed id, with no statement sent, and holds no operator id", async () => {
    const s = await resolvedCase();
    const spy = vi.spyOn(t.pg, "query");
    expect(await getAppealFormView(t.db, s.filer.operator.id, "nope", at(DAY))).toBeNull();
    expect(await getAppealFormView(t.db, "nope", s.c.id, at(DAY))).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const text = JSON.stringify(await getAppealFormView(t.db, s.filer.operator.id, s.c.id, at(DAY)));
    expect(text).not.toContain(s.filer.operator.id);
    expect(text).not.toMatch(/operator_?id/i);
  });
});
