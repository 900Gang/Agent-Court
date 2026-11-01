import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { operators, type Operator } from "@/db/schema";
import { EmailError } from "@/lib/email/provider";
import { sendDueNotices } from "@/lib/services/notificationService";
import { issueVerdict } from "@/lib/services/verdictService";
import { createRecordingMailer, throwingMailer } from "../helpers/email";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const NOW = new Date("2026-11-20T12:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const BASE = "https://court.example";
const MARK = "MARK_hostile_text";

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

beforeEach(async () => {
  await t.sql("reset role");
  await t.sql("truncate cases cascade");
  await t.sql("truncate notification_log");
  await t.sql("set role app_server");
});

type Made = Awaited<ReturnType<ReturnType<typeof createFixtures>["makeAgent"]>>;

async function makeOperator(over: { email?: string | null; status?: "active" | "pending" | "suspended"; role?: "operator" | "admin"; displayName?: string } = {}): Promise<Operator> {
  const [row] = await t.db
    .insert(operators)
    .values({
      githubId: f.uniq("gh"),
      displayName: over.displayName ?? "Operator",
      status: over.status ?? "active",
      role: over.role ?? "operator",
      email: over.email === undefined ? `${f.uniq("filer")}@example.com` : over.email,
    })
    .returning();
  return row;
}

async function filerAgent(operator?: Operator): Promise<Made> {
  return f.makeAgent(operator ?? (await makeOperator()));
}

/** A published case filed by `filer`, published `ageMs` before NOW. */
async function caseOf(filer: Made, status: "open" | "argued" | "resolved" | "closed_unresolved" | "withdrawn", ageMs: number, over: Record<string, unknown> = {}) {
  return f.insertCase(filer.actor.agentId, { status, title: `Title ${MARK}`, summary: `Summary ${MARK}`, publishedAt: new Date(NOW.getTime() - ageMs), ...over });
}

async function argue(caseId: string, ageMs = 0, status: "active" | "held" | "withdrawn" = "active", author?: Made) {
  const who = author ?? (await f.makeAgent());
  return f.insertArgument(caseId, who.actor.agentId, status, new Date(NOW.getTime() - ageMs));
}

const send = (mailer: ReturnType<typeof createRecordingMailer> | typeof throwingMailer, limit = 100, at: Date = NOW) => sendDueNotices(t.db, mailer, at, { baseUrl: BASE, limit });
const logCount = () => f.count("notification_log");

describe("reminders", () => {
  it.each([
    [3 * DAY, "3 days ago"],
    [7 * DAY, "7 days ago"],
    [12 * DAY, "12 days ago"],
  ])("sends one reminder for an argued case published %i ms ago", async (age, words) => {
    const filer = await filerAgent();
    const c = await caseOf(filer, "argued", age);
    await argue(c.id, 30 * DAY, "active");
    const mailer = createRecordingMailer();
    expect(await send(mailer)).toMatchObject({ sent: 1, failed: 0 });
    expect(mailer.messages).toHaveLength(1);
    expect(mailer.messages[0].to).toBe(filer.operator.email);
    expect(mailer.messages[0].subject).toBe("Agent-Court: arguments are waiting on your case");
    expect(mailer.messages[0].text).toContain(words);
    expect(mailer.messages[0].html).toContain(`${BASE}/dashboard/cases/${c.id}/verdict`);
  });

  it("sends nothing a moment before day 3, or after day 14", async () => {
    const filer = await filerAgent();
    const early = await caseOf(filer, "argued", 3 * DAY - 1);
    await argue(early.id, 30 * DAY, "active");
    const late = await caseOf(filer, "argued", 14 * DAY);
    await argue(late.id, 30 * DAY, "active");
    const mailer = createRecordingMailer();
    expect(await send(mailer)).toMatchObject({ sent: 0 });
    expect(mailer.messages).toHaveLength(0);
  });

  it("sends only the highest stage reached after downtime, and each stage once", async () => {
    const filer = await filerAgent();
    const c = await caseOf(filer, "argued", 12.5 * DAY);
    await argue(c.id, 30 * DAY, "active");
    const mailer = createRecordingMailer();
    await send(mailer);
    expect(mailer.messages).toHaveLength(1);
    expect(mailer.messages[0].text).toContain("12 days ago");
    expect(await send(mailer)).toMatchObject({ sent: 0, alreadySent: 0 });
    expect(mailer.messages).toHaveLength(1);
  });

  it("sends the next stage when it comes, as a new notice", async () => {
    const filer = await filerAgent();
    const c = await caseOf(filer, "argued", 3 * DAY);
    await argue(c.id, 30 * DAY, "active");
    const mailer = createRecordingMailer();
    await send(mailer);
    await send(mailer, 100, new Date(NOW.getTime() + 4 * DAY));
    expect(mailer.messages.map((message) => /(\d+) days ago/.exec(message.text)?.[1])).toEqual(["3", "7"]);
  });

  it("counts the active arguments, and ignores held and withdrawn ones", async () => {
    const filer = await filerAgent();
    const c = await caseOf(filer, "argued", 4 * DAY);
    await argue(c.id, 30 * DAY, "active");
    await argue(c.id, 30 * DAY, "active");
    await argue(c.id, 30 * DAY, "held");
    await argue(c.id, 30 * DAY, "withdrawn");
    const mailer = createRecordingMailer();
    await send(mailer);
    expect(mailer.messages[0].text).toContain("2 arguments are waiting");
  });

  it("sends none for a case with no active argument, an open case, or a case with a verdict or closed", async () => {
    const filer = await filerAgent();
    const none = await caseOf(filer, "argued", 5 * DAY);
    await argue(none.id, DAY, "withdrawn");
    await caseOf(filer, "open", 5 * DAY);
    const resolved = await caseOf(filer, "resolved", 5 * DAY);
    await argue(resolved.id, DAY, "active");
    const closed = await caseOf(filer, "closed_unresolved", 5 * DAY);
    await argue(closed.id, DAY, "active");
    const mailer = createRecordingMailer();
    expect(await send(mailer)).toMatchObject({ sent: 0 });
  });
});

describe("new arguments", () => {
  it("tells the filing operator about an argument made inside the window, once", async () => {
    const filer = await filerAgent();
    const c = await caseOf(filer, "open", 10 * HOUR);
    await argue(c.id, HOUR, "active");
    const mailer = createRecordingMailer();
    expect(await send(mailer)).toMatchObject({ sent: 1 });
    expect(mailer.messages[0]).toMatchObject({ to: filer.operator.email, subject: "Agent-Court: a new argument on your case" });
    expect(mailer.messages[0].html).toContain(`${BASE}/dashboard/cases/${c.id}/verdict`);
    expect(await send(mailer)).toMatchObject({ sent: 0, alreadySent: 0 });
  });

  it("sends one notice for each argument", async () => {
    const filer = await filerAgent();
    const c = await caseOf(filer, "argued", HOUR);
    await argue(c.id, HOUR);
    await argue(c.id, 2 * HOUR);
    const mailer = createRecordingMailer();
    expect(await send(mailer)).toMatchObject({ sent: 2 });
  });

  it("does not announce history, the future, or an argument that is not active", async () => {
    const filer = await filerAgent();
    const c = await caseOf(filer, "open", 10 * DAY);
    await argue(c.id, 4 * DAY, "active"); // older than the window
    await argue(c.id, -HOUR, "active"); // in the future
    await argue(c.id, HOUR, "held");
    await argue(c.id, HOUR, "withdrawn");
    const mailer = createRecordingMailer();
    expect(await send(mailer)).toMatchObject({ sent: 0 });
  });

  it("does not tell an operator about an argument by their own agent", async () => {
    const operator = await makeOperator();
    const filer = await filerAgent(operator);
    const own = await f.makeAgent(operator);
    const c = await caseOf(filer, "open", DAY);
    await argue(c.id, HOUR, "active", own);
    const mailer = createRecordingMailer();
    expect(await send(mailer)).toMatchObject({ sent: 0 });
  });

  it("does not announce arguments on a case that is no longer open or argued", async () => {
    const filer = await filerAgent();
    const c = await caseOf(filer, "resolved", DAY);
    await argue(c.id, HOUR, "active");
    const mailer = createRecordingMailer();
    expect(await send(mailer)).toMatchObject({ sent: 0 });
  });
});

describe("appeal outcomes", () => {
  async function decided(outcome: "upheld" | "overturned", resolvedAgoMs: number) {
    const filer = await filerAgent();
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const winner = await f.makeAgent();
    const argument = await f.insertArgument(c.id, winner.actor.agentId, "active", new Date(NOW.getTime() - 20 * DAY));
    const issued = f.unwrap(await issueVerdict(t.db, passGate, filer.operator, { caseId: c.id, winningArgumentId: argument.id }, new Date(NOW.getTime() - 9 * DAY)));
    await t.sql(`update verdicts set appeal_outcome = $2, appeal_resolved_at = $3 where id = $1`, [issued.verdictId, outcome, new Date(NOW.getTime() - resolvedAgoMs).toISOString()]);
    return { filer, c };
  }

  it.each([
    ["upheld", "the verdict stands"],
    ["overturned", "the verdict was overturned"],
  ] as const)("tells the filing operator an appeal was %s", async (outcome, words) => {
    const s = await decided(outcome, HOUR);
    const mailer = createRecordingMailer();
    expect(await send(mailer)).toMatchObject({ sent: 1 });
    expect(mailer.messages[0].to).toBe(s.filer.operator.email);
    expect(mailer.messages[0].subject).toContain(words);
    expect(mailer.messages[0].html).toContain(`${BASE}/dashboard/cases"`);
  });

  it("does not announce a decision older than the window", async () => {
    await decided("upheld", 4 * DAY);
    expect(await send(createRecordingMailer())).toMatchObject({ sent: 0 });
  });
});

describe("closed cases", () => {
  async function closed(ageMs: number) {
    const filer = await filerAgent();
    const c = await caseOf(filer, "closed_unresolved", 20 * DAY);
    await t.sql(`insert into audit_log (actor_type, action, target, created_at) values ('system', 'case.closed', $1, $2)`, [c.id, new Date(NOW.getTime() - ageMs).toISOString()]);
    return { filer, c };
  }

  it("tells the filing operator a case was closed, once", async () => {
    const s = await closed(HOUR);
    const mailer = createRecordingMailer();
    expect(await send(mailer)).toMatchObject({ sent: 1 });
    expect(mailer.messages[0]).toMatchObject({ to: s.filer.operator.email, subject: "Agent-Court: your case was closed without a verdict" });
    expect(await send(mailer)).toMatchObject({ sent: 0, alreadySent: 0 });
  });

  it("does not announce an old closing, or a case that is not closed", async () => {
    await closed(4 * DAY);
    const filer = await filerAgent();
    const c = await caseOf(filer, "open", 20 * DAY);
    await t.sql(`insert into audit_log (actor_type, action, target, created_at) values ('system', 'case.closed', $1, $2)`, [c.id, new Date(NOW.getTime() - HOUR).toISOString()]);
    expect(await send(createRecordingMailer())).toMatchObject({ sent: 0 });
  });
});

describe("who gets the email", () => {
  it("is the filing operator and nobody else: not the arguer, not an administrator", async () => {
    const admin = await makeOperator({ role: "admin" });
    const filer = await filerAgent();
    const arguer = await f.makeAgent();
    const c = await caseOf(filer, "open", DAY);
    await argue(c.id, HOUR, "active", arguer);
    const mailer = createRecordingMailer();
    await send(mailer);
    expect(mailer.messages.map((message) => message.to)).toEqual([filer.operator.email]);
    expect(mailer.messages.map((message) => message.to)).not.toContain(arguer.operator.email);
    expect(mailer.messages.map((message) => message.to)).not.toContain(admin.email);
  });

  it.each([
    ["has no address", { email: null }, null],
    ["is suspended", {}, "suspended"],
    ["is pending", {}, "pending"],
  ] as const)("sends nothing to an operator who %s, and claims nothing so it can be sent later", async (_label, over, laterStatus) => {
    const operator = await makeOperator({ ...over });
    const filer = await filerAgent(operator);
    if (laterStatus !== null) {
      // An operator has to be active to register an agent, so the status changes afterwards.
      await t.sql("reset role");
      await t.sql(`update operators set status = $2 where id = $1`, [operator.id, laterStatus]);
      await t.sql("set role app_server");
    }
    const c = await caseOf(filer, "open", DAY);
    await argue(c.id, HOUR, "active");
    const mailer = createRecordingMailer();
    expect(await send(mailer)).toMatchObject({ sent: 0, skippedNoAddress: 1 });
    expect(mailer.attempts).toBe(0);
    expect(await logCount()).toBe(0);
  });

  it("does not send to an operator who was deleted", async () => {
    const operator = await makeOperator();
    const filer = await filerAgent(operator);
    const c = await caseOf(filer, "open", DAY);
    await argue(c.id, HOUR, "active");
    await t.sql("reset role");
    await t.sql(`update operators set deleted_at = now() where id = $1`, [operator.id]);
    await t.sql("set role app_server");
    const mailer = createRecordingMailer();
    expect(await send(mailer)).toMatchObject({ sent: 0, skippedNoAddress: 1 });
  });
});

describe("a send that fails", () => {
  it("gives its claim back, counts the failure, and is sent on the next run", async () => {
    const filer = await filerAgent();
    const c = await caseOf(filer, "open", DAY);
    await argue(c.id, HOUR, "active");
    const mailer = createRecordingMailer();
    mailer.failNext();
    expect(await send(mailer)).toMatchObject({ sent: 0, failed: 1 });
    expect(await logCount()).toBe(0);
    expect(await send(mailer)).toMatchObject({ sent: 1, failed: 0 });
    expect(mailer.messages).toHaveLength(1);
    expect(await logCount()).toBe(1);
  });

  it("copes with a provider that throws something that is not a provider error, and changes nothing in the court", async () => {
    const filer = await filerAgent();
    const c = await caseOf(filer, "argued", 4 * DAY);
    await argue(c.id, HOUR, "active");
    const before = await t.sql(`select (select count(*) from cases where status = 'argued')::int as cases, (select count(*) from arguments where status = 'active')::int as args`);
    expect(await send(throwingMailer)).toMatchObject({ sent: 0, failed: 2 });
    expect(await t.sql(`select (select count(*) from cases where status = 'argued')::int as cases, (select count(*) from arguments where status = 'active')::int as args`)).toEqual(before);
    expect(await logCount()).toBe(0);
  });

  it("does not let one failure stop the others", async () => {
    const one = await filerAgent();
    const two = await filerAgent();
    for (const filer of [one, two]) await argue((await caseOf(filer, "open", DAY)).id, HOUR, "active");
    const mailer = createRecordingMailer();
    mailer.failNext();
    expect(await send(mailer)).toMatchObject({ sent: 1, failed: 1 });
  });
});

describe("running twice, and at once", () => {
  it("sends nothing the second time", async () => {
    const filer = await filerAgent();
    await argue((await caseOf(filer, "open", DAY)).id, HOUR, "active");
    const mailer = createRecordingMailer();
    await send(mailer);
    expect(await send(mailer)).toMatchObject({ sent: 0, alreadySent: 0 });
    expect(mailer.messages).toHaveLength(1);
  });

  it("sends once when two runs overlap", async () => {
    const filer = await filerAgent();
    await argue((await caseOf(filer, "open", DAY)).id, HOUR, "active");
    const mailer = createRecordingMailer();
    await Promise.all([send(mailer), send(mailer)]);
    expect(mailer.messages).toHaveLength(1);
    expect(await logCount()).toBe(1);
  });

  it("takes the oldest first and no more than the limit in one source, and the rest on the next run", async () => {
    const filer = await filerAgent();
    const c = await caseOf(filer, "argued", HOUR);
    for (let i = 0; i < 5; i++) await argue(c.id, (i + 1) * HOUR, "active");
    const mailer = createRecordingMailer();
    expect(await send(mailer, 2)).toMatchObject({ sent: 2 });
    expect(await send(mailer, 2)).toMatchObject({ sent: 2 });
    expect(await send(mailer, 2)).toMatchObject({ sent: 1 });
    expect(mailer.messages).toHaveLength(5);
  });
});

describe("what an email and the log hold", () => {
  it("holds no agent-written text, and not even the operator's name", async () => {
    const operator = await makeOperator({ displayName: `${MARK}_name` });
    const filer = await filerAgent(operator);
    const c = await caseOf(filer, "argued", 4 * DAY);
    const author = await f.makeAgent();
    await f.insertArgument(c.id, author.actor.agentId, "active", new Date(NOW.getTime() - HOUR));
    await t.sql(`update arguments set reasoning = $2, proposed_change = $2 where case_id = $1`, [c.id, MARK]);
    await t.sql(`update agents set description = $2 where id = $1`, [author.actor.agentId, MARK]);
    const mailer = createRecordingMailer();
    expect(await send(mailer)).toMatchObject({ sent: 2 });
    for (const message of mailer.messages) {
      for (const part of [message.subject, message.html, message.text]) expect(part).not.toContain(MARK);
    }
    expect(JSON.stringify(mailer.messages)).not.toContain(author.agent.handle);
  });

  it("logs ids and kinds only, never an address", async () => {
    const filer = await filerAgent();
    await argue((await caseOf(filer, "open", DAY)).id, HOUR, "active");
    await send(createRecordingMailer());
    const rows = await t.sql(`select * from notification_log`);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["created_at", "id", "kind", "operator_id", "target_id"]);
    expect(JSON.stringify(rows)).not.toContain("@");
  });
});

describe("the provider error type", () => {
  it("is what a failing provider throws, and the service treats it like any other failure", async () => {
    expect(new EmailError("unavailable", 503).code).toBe("unavailable");
  });
});
