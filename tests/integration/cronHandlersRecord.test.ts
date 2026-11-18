import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  handleCronAutoClose,
  handleCronReembed,
  handleCronReleaseReputation,
  handleCronReminders,
  handleCronRescan,
  type CronDeps,
} from "@/lib/http/handlers/cron";
import { createGate } from "@/lib/safety/engine";
import { createTestDb, type TestDb } from "../helpers/db";

// N10 Task 3 (AC-1005, AC-1006): each scheduled route records one run in cron_runs, and a refused call records none.

let t: TestDb;
const SECRET = ["cron", "secret", "value", "0123456789", "abcdef"].join("-");
const NOW = new Date("2026-11-18T12:00:00.000Z");

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

beforeEach(async () => {
  await t.sql("reset role");
  await t.sql("truncate cron_runs");
  await t.sql("set role app_server");
});

const deps = (over: Partial<CronDeps> = {}): CronDeps => ({ db: t.db, gate: createGate(), secret: SECRET, now: NOW, ...over });
const authed = () => new Request("http://localhost:3000/api/cron/x", { headers: { authorization: `Bearer ${SECRET}` } });
const anonymous = () => new Request("http://localhost:3000/api/cron/x");
const runs = () => t.sql("select route, ok, counts from cron_runs order by finished_at, id");

const HANDLERS: Array<[string, string, (request: Request, d: CronDeps) => Promise<Response>]> = [
  ["rescan", "rescan", handleCronRescan],
  ["reembed", "reembed", handleCronReembed],
  ["auto-close", "auto-close", handleCronAutoClose],
  ["release-reputation", "release-reputation", handleCronReleaseReputation],
  ["reminders", "reminders", handleCronReminders],
];

describe.each(HANDLERS)("the %s route", (_name, route, handler) => {
  it("records one successful run with counts only, and answers as before", async () => {
    const response = await handler(authed(), deps());
    expect(response.status).toBe(200);
    const body = await response.json();
    const recorded = await runs();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].route).toBe(route);
    expect(recorded[0].ok).toBe(true);
    for (const value of Object.values(recorded[0].counts as Record<string, unknown>)) {
      expect(["number", "boolean"]).toContain(typeof value);
    }
    expect(Object.keys(body).length).toBeGreaterThan(0);
  });

  it("records nothing for a call without the secret", async () => {
    expect((await handler(anonymous(), deps())).status).toBe(401);
    expect(await runs()).toHaveLength(0);
  });

  it("records nothing when no secret is configured", async () => {
    expect((await handler(authed(), deps({ secret: null }))).status).toBe(401);
    expect(await runs()).toHaveLength(0);
  });
});

describe("the routes that can be switched off by a setting", () => {
  it("records a run with disabled: true when there is no embeddings provider", async () => {
    await handleCronReembed(authed(), deps({ embedder: null }));
    const [row] = await runs();
    expect(row.ok).toBe(true);
    expect(row.counts).toMatchObject({ disabled: true });
  });

  it("records a run with disabled: true when there is no mail provider", async () => {
    await handleCronReminders(authed(), deps({ mailer: null }));
    const [row] = await runs();
    expect(row.ok).toBe(true);
    expect(row.counts).toMatchObject({ disabled: true });
  });
});
