import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { errorResponse } from "@/lib/http/errors";
import { handleCronAutoClose, handleCronReleaseReputation } from "@/lib/http/handlers/cron";
import { createGate } from "@/lib/safety/engine";
import { appealVerdict, issueVerdict } from "@/lib/services/verdictService";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const SECRET = ["cron", "secret", "value", "0123456789", "abcdef"].join("-");
const NOW = new Date("2026-11-20T12:00:00.000Z");
const DAY = 86_400_000;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

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
  await t.sql("set role app_server");
});

const deps = (secret: string | null = SECRET) => ({ db: t.db, gate: createGate(), secret, now: NOW });
const authorized = { headers: { authorization: `Bearer ${SECRET}` } };

const ROUTES = [
  ["auto-close", (init: RequestInit & { url?: string } = {}, secret: string | null = SECRET) => handleCronAutoClose(new Request(init.url ?? "http://localhost:3000/api/cron/auto-close", init), deps(secret))],
  ["release-reputation", (init: RequestInit & { url?: string } = {}, secret: string | null = SECRET) => handleCronReleaseReputation(new Request(init.url ?? "http://localhost:3000/api/cron/release-reputation", init), deps(secret))],
] as const;

const bodyOf = async (response: Response) => (await response.json()) as Json;

/** A resolved case whose verdict was issued `daysAgo` days before NOW, with a pending event. */
async function resolvedCase(daysAgo: number) {
  const filer = await f.makeAgent();
  const c = await f.insertCase(filer.actor.agentId, { status: "open", title: "MARK_title", publishedAt: new Date(NOW.getTime() - (daysAgo + 1) * DAY) });
  const winner = await f.makeAgent();
  const argument = await f.insertArgument(c.id, winner.actor.agentId, "active");
  const issued = f.unwrap(await issueVerdict(t.db, passGate, filer.operator, { caseId: c.id, winningArgumentId: argument.id }, new Date(NOW.getTime() - daysAgo * DAY)));
  return { c, filer, winner, verdictId: issued.verdictId };
}

const eventStatus = async (verdictId: string) => (await t.sql(`select status from reputation_events where verdict_id = $1`, [verdictId]))[0].status as string;

describe.each(ROUTES)("the %s endpoint: who may call it", (_name, call) => {
  const refused: Array<[string, RequestInit & { url?: string }, string | null]> = [
    ["no header", {}, SECRET],
    ["a wrong secret", { headers: { authorization: "Bearer not-the-secret" } }, SECRET],
    ["the Basic scheme", { headers: { authorization: `Basic ${SECRET}` } }, SECRET],
    ["a secret in the query string", { url: `http://localhost:3000/api/cron/x?secret=${SECRET}` }, SECRET],
    ["the right header when no secret is configured", authorized, null],
  ];

  it.each(refused)("answers %s with the same fixed 401, and changes nothing", async (_label, init, secret) => {
    const idle = await f.makeAgent();
    const old = await f.insertCase(idle.actor.agentId, { status: "open", publishedAt: new Date(NOW.getTime() - 30 * DAY) });
    const due = await resolvedCase(8);
    const response = await call(init, secret);
    const expected = errorResponse("unauthorized");
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(await expected.text());
    expect((await t.sql(`select status from cases where id = $1`, [old.id]))[0].status).toBe("open");
    expect(await eventStatus(due.verdictId)).toBe("pending");
  });

  it.each(["GET", "POST"])("accepts %s with the right secret", async (method) => {
    expect((await call({ method, ...authorized })).status).toBe(200);
  });

  it("is never cached", async () => {
    expect((await call(authorized)).headers.get("cache-control")).toBe("no-store");
  });
});

describe("the auto-close endpoint: what it does", () => {
  it("closes idle cases and answers with counts only", async () => {
    const idle = await f.makeAgent();
    const old = await f.insertCase(idle.actor.agentId, { status: "open", title: "MARK_title", publishedAt: new Date(NOW.getTime() - 30 * DAY) });
    await f.insertCase(idle.actor.agentId, { status: "open", publishedAt: new Date(NOW.getTime() - 2 * DAY) });
    const response = await ROUTES[0][1](authorized);
    expect(await bodyOf(response)).toEqual({ closed: 1, remaining: 0 });
    expect((await t.sql(`select status from cases where id = $1`, [old.id]))[0].status).toBe("closed_unresolved");
  });

  it("does nothing the second time, and its answer holds no case id or title", async () => {
    const idle = await f.makeAgent();
    const old = await f.insertCase(idle.actor.agentId, { status: "open", title: "MARK_title", publishedAt: new Date(NOW.getTime() - 30 * DAY) });
    const first = await (await ROUTES[0][1](authorized)).text();
    const second = await ROUTES[0][1](authorized);
    expect(await bodyOf(second)).toEqual({ closed: 0, remaining: 0 });
    for (const text of [first, JSON.stringify(await bodyOf(await ROUTES[0][1](authorized)))]) {
      expect(text).not.toContain(old.id);
      expect(text).not.toContain("MARK_title");
    }
  });
});

describe("the release endpoint: what it does", () => {
  it("makes due points final, and answers with the count only", async () => {
    const due = await resolvedCase(8); // release_at was a day ago
    const response = await ROUTES[1][1](authorized);
    expect(await bodyOf(response)).toEqual({ released: 1 });
    expect(await eventStatus(due.verdictId)).toBe("final");
  });

  it("leaves points that are not due yet", async () => {
    const early = await resolvedCase(6); // release_at is tomorrow
    expect(await bodyOf(await ROUTES[1][1](authorized))).toEqual({ released: 0 });
    expect(await eventStatus(early.verdictId)).toBe("pending");
  });

  it("leaves the points of a verdict under appeal, and releases them once the appeal is upheld", async () => {
    const s = await resolvedCase(8);
    f.unwrap(await appealVerdict(t.db, passGate, s.filer.operator, { caseId: s.c.id, reason: "The fix did not hold on the second run." }, new Date(NOW.getTime() - 7.5 * DAY)));
    expect(await bodyOf(await ROUTES[1][1](authorized))).toEqual({ released: 0 });
    expect(await eventStatus(s.verdictId)).toBe("pending");
    await t.sql(`update verdicts set status = 'active', appeal_outcome = 'upheld' where id = $1`, [s.verdictId]);
    await t.sql(`update cases set status = 'resolved' where id = $1`, [s.c.id]);
    expect(await bodyOf(await ROUTES[1][1](authorized))).toEqual({ released: 1 });
    expect(await eventStatus(s.verdictId)).toBe("final");
  });

  it("leaves reversed and already final events alone, and does nothing the second time", async () => {
    const one = await resolvedCase(8);
    const two = await resolvedCase(9);
    await t.sql(`update reputation_events set status = 'reversed' where verdict_id = $1`, [two.verdictId]);
    expect(await bodyOf(await ROUTES[1][1](authorized))).toEqual({ released: 1 });
    expect(await bodyOf(await ROUTES[1][1](authorized))).toEqual({ released: 0 });
    expect(await eventStatus(one.verdictId)).toBe("final");
    expect(await eventStatus(two.verdictId)).toBe("reversed");
  });

  it("answers a self-resolved verdict, which earned nothing, with nothing to release", async () => {
    const filer = await f.makeAgent();
    const own = await f.makeAgent(filer.operator);
    const c = await f.insertCase(filer.actor.agentId, { status: "open" });
    const argument = await f.insertArgument(c.id, own.actor.agentId, "active");
    f.unwrap(await issueVerdict(t.db, passGate, filer.operator, { caseId: c.id, winningArgumentId: argument.id }, new Date(NOW.getTime() - 9 * DAY)));
    expect(await bodyOf(await ROUTES[1][1](authorized))).toEqual({ released: 0 });
  });
});
