import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { operators } from "@/db/schema";
import { errorResponse } from "@/lib/http/errors";
import { handleCronReminders } from "@/lib/http/handlers/cron";
import type { EmailProvider } from "@/lib/email/provider";
import { createGate } from "@/lib/safety/engine";
import { createRecordingMailer, throwingMailer } from "../helpers/email";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const SECRET = ["cron", "secret", "value", "0123456789", "abcdef"].join("-");
const NOW = new Date("2026-11-20T12:00:00.000Z");
const HOUR = 3_600_000;
const BASE = "https://court.example";
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
  await t.sql("truncate notification_log");
  await t.sql("set role app_server");
});

const deps = (mailer: EmailProvider | null | undefined, secret: string | null = SECRET, baseUrl: string | undefined = BASE) => ({ db: t.db, gate: createGate(), secret, now: NOW, mailer, baseUrl });
const call = (mailer: EmailProvider | null | undefined, init: RequestInit & { url?: string } = {}, secret: string | null = SECRET) =>
  handleCronReminders(new Request(init.url ?? "http://localhost:3000/api/cron/reminders", init), deps(mailer, secret));
const authorized = { headers: { authorization: `Bearer ${SECRET}` } };
const bodyOf = async (response: Response) => (await response.json()) as Json;

async function newArgument() {
  const [operator] = await t.db.insert(operators).values({ githubId: f.uniq("gh"), displayName: "Op", status: "active", email: `${f.uniq("filer")}@example.com` }).returning();
  const filer = await f.makeAgent(operator);
  const c = await f.insertCase(filer.actor.agentId, { status: "open", publishedAt: new Date(NOW.getTime() - 5 * HOUR) });
  const author = await f.makeAgent();
  await f.insertArgument(c.id, author.actor.agentId, "active", new Date(NOW.getTime() - HOUR));
  return { operator, c };
}

const ZERO = { disabled: false, sent: 0, failed: 0, skippedNoAddress: 0, alreadySent: 0 };

describe("the reminders endpoint: who may call it", () => {
  const refused: Array<[string, RequestInit & { url?: string }, string | null]> = [
    ["no header", {}, SECRET],
    ["a wrong secret", { headers: { authorization: "Bearer not-the-secret" } }, SECRET],
    ["the Basic scheme", { headers: { authorization: `Basic ${SECRET}` } }, SECRET],
    ["a secret in the query string", { url: `http://localhost:3000/api/cron/reminders?secret=${SECRET}` }, SECRET],
    ["the right header when no secret is configured", authorized, null],
  ];

  it.each(refused)("answers %s with the same fixed 401, and sends nothing", async (_label, init, secret) => {
    await newArgument();
    const mailer = createRecordingMailer();
    const response = await call(mailer, init, secret);
    const expected = errorResponse("unauthorized");
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(await expected.text());
    expect(mailer.attempts).toBe(0);
    expect(await f.count("notification_log")).toBe(0);
  });

  it("is refused the same way when there is no mailer", async () => {
    expect((await call(null)).status).toBe(401);
  });

  it.each(["GET", "POST"])("accepts %s with the right secret", async (method) => {
    expect((await call(createRecordingMailer(), { method, ...authorized })).status).toBe(200);
  });

  it("is never cached", async () => {
    expect((await call(createRecordingMailer(), authorized)).headers.get("cache-control")).toBe("no-store");
  });
});

describe("the reminders endpoint: what it does", () => {
  it("answers 200 with disabled and zeros when there is no mailer, and does nothing", async () => {
    await newArgument();
    const response = await call(null, authorized);
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ...ZERO, disabled: true });
    expect(await f.count("notification_log")).toBe(0);
  });

  it("answers 200 with disabled when there is no base address to build links from", async () => {
    const mailer = createRecordingMailer();
    const response = await handleCronReminders(new Request("http://localhost:3000/api/cron/reminders", authorized), { ...deps(mailer), baseUrl: undefined });
    expect(await bodyOf(response)).toEqual({ ...ZERO, disabled: true });
    expect(mailer.attempts).toBe(0);
  });

  it("sends what is due and answers with counts only", async () => {
    const s = await newArgument();
    const mailer = createRecordingMailer();
    const response = await call(mailer, authorized);
    expect(await bodyOf(response)).toEqual({ ...ZERO, sent: 1 });
    expect(mailer.messages).toHaveLength(1);
    const text = JSON.stringify(mailer.messages);
    expect(text).toContain(s.c.id);
  });

  it("sends nothing the second time", async () => {
    await newArgument();
    const mailer = createRecordingMailer();
    await call(mailer, authorized);
    expect(await bodyOf(await call(mailer, authorized))).toEqual({ ...ZERO });
    expect(mailer.messages).toHaveLength(1);
  });

  it("answers 200 with the failure counted when the mail provider fails, and tries again next time", async () => {
    await newArgument();
    const mailer = createRecordingMailer();
    mailer.failNext();
    const failed = await call(mailer, authorized);
    expect(failed.status).toBe(200);
    expect(await bodyOf(failed)).toEqual({ ...ZERO, failed: 1 });
    expect(await bodyOf(await call(mailer, authorized))).toEqual({ ...ZERO, sent: 1 });
  });

  it("answers 200 even when the provider throws something unexpected", async () => {
    await newArgument();
    const response = await call(throwingMailer, authorized);
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ...ZERO, failed: 1 });
  });

  it("holds no case id, no address and no text in its answer", async () => {
    const s = await newArgument();
    const text = await (await call(createRecordingMailer(), authorized)).text();
    expect(text).not.toContain(s.c.id);
    expect(text).not.toContain("@");
    expect(text).not.toContain("SENTINEL_FAILURE_TEXT");
  });
});

describe("the reminders route file", () => {
  const source = readFileSync(path.resolve(process.cwd(), "app/api/cron/reminders/route.ts"), "utf8");

  it("answers GET and POST by the handler, and is never cached", () => {
    expect(source).toMatch(/export (?:async )?function GET/);
    expect(source).toMatch(/export (?:async )?function POST/);
    expect(source).toContain("handleCronReminders");
    expect(source).toContain("getCronDeps()");
    expect(source).toMatch(/dynamic\s*=\s*"force-dynamic"/);
  });

  it("is no longer the not-implemented stub", () => {
    expect(source).not.toContain("501");
    expect(source).not.toContain("Not implemented");
  });

  it("checks the secret before it touches the database or the mailer", () => {
    const handler = readFileSync(path.resolve(process.cwd(), "lib/http/handlers/cron.ts"), "utf8");
    const body = handler.slice(handler.indexOf("export async function handleCronReminders"));
    expect(body.indexOf("verifyCronRequest(")).toBeGreaterThan(-1);
    expect(body.indexOf("verifyCronRequest(")).toBeLessThan(body.indexOf("deps.db"));
    expect(body.indexOf("verifyCronRequest(")).toBeLessThan(body.indexOf("deps.mailer"));
  });
});
