import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiDeps } from "@/lib/http/apiPipeline";
import { handleFileCase } from "@/lib/http/handlers/cases";
import { getCronDeps, handleCronHealthCheck, type CronDeps } from "@/lib/http/handlers/cron";
import { createMemoryCounters } from "@/lib/metrics/counters";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import { createGate } from "@/lib/safety/engine";
import { issueKey } from "@/lib/services/keyService";
import { loadSpikeTexts, runSpike } from "@/scripts/simulate-injection-spike";
import { createRecordingMailer } from "../helpers/email";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

// N10 Task 5 (AC-1006): the proof that an alert fires on a simulated injection spike. The script's own code files the
// cases and calls the check; only the network is replaced, by an answer from the real handlers, the real gate and an
// in-memory database. This is the automated half of the check; the owner repeats it on staging with the real script.

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const SECRET = ["cron", "secret", "value", "0123456789", "abcdef"].join("-");
const BASE = "https://court.example.test";
const TO = "ops@example.test";
const DAY = 86_400_000;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

async function stagingWorld() {
  const made = await f.makeAgent();
  const issued = f.unwrap(await issueKey(t.db, made.operator, made.agent.id, { scopes: ["read", "cases:write"] }));
  const counters = createMemoryCounters();
  const mailer = createRecordingMailer();
  const apiDeps: ApiDeps = {
    db: t.db,
    limiter: createMemoryLimiter(),
    gate: createGate(),
    writesEnabled: true,
    now: new Date(Date.now() + 30 * DAY), // an established agent: 60 requests a minute
    counters,
  };
  const cronDeps: CronDeps = { db: t.db, gate: createGate(), secret: SECRET, mailer, baseUrl: BASE, alertTo: TO, counters };
  // Answers a request the way the deployment would.
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(String(input), init);
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/cases") return handleFileCase(request, apiDeps);
    if (path === "/api/cron/health-check") return handleCronHealthCheck(request, cronDeps);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { key: issued.key, mailer, fetchImpl, cronDeps };
}

describe("the spike simulation", () => {
  it("has enough plain injection texts to cross the alert level", () => {
    expect(loadSpikeTexts().length).toBeGreaterThanOrEqual(30);
  });

  it("makes the alert fire: one email about the flag rate, with counts only", async () => {
    const world = await stagingWorld();
    const result = await runSpike({ baseUrl: BASE, apiKey: world.key, cronSecret: SECRET, count: 30, fetchImpl: world.fetchImpl, runId: "t1" });

    expect(result.sent).toBe(30);
    expect(Object.values(result.byStatus).reduce((sum, n) => sum + n, 0)).toBe(30);
    expect(result.health.status).toBe(200);
    expect(result.health.summary).toMatchObject({ disabled: false, sent: 1, failed: 0 });
    expect(result.health.summary.findings).toBeGreaterThanOrEqual(1);

    const flag = world.mailer.messages.find((message) => message.subject === "Agent-Court alert: flag rate is high");
    expect(flag).toBeDefined();
    expect(flag!.to).toBe(TO);
    // the alert says how many, and none of the injection text it was about
    expect(flag!.text).toMatch(/\d+ of \d+/);
    for (const text of loadSpikeTexts().slice(0, 30)) {
      expect(flag!.html).not.toContain(text.slice(0, 25));
      expect(flag!.text).not.toContain(text.slice(0, 25));
    }
  });

  it("stays quiet when the same check runs again inside the cool-down", async () => {
    const world = await stagingWorld();
    await runSpike({ baseUrl: BASE, apiKey: world.key, cronSecret: SECRET, count: 30, fetchImpl: world.fetchImpl, runId: "t2" });
    const before = world.mailer.messages.length;
    const again = await handleCronHealthCheck(new Request(`${BASE}/api/cron/health-check`, { headers: { authorization: `Bearer ${SECRET}` } }), world.cronDeps);
    const body = await again.json();
    expect(body.coolingDown).toBeGreaterThanOrEqual(1);
    expect(body.sent).toBe(0);
    expect(world.mailer.messages).toHaveLength(before);
  });

  it("is refused by the check without the secret, and sends nothing", async () => {
    const world = await stagingWorld();
    const result = await runSpike({ baseUrl: BASE, apiKey: world.key, cronSecret: "wrong-secret-value-0123456789-abcdef", count: 3, fetchImpl: world.fetchImpl, runId: "t3" });
    expect(result.health.status).toBe(401);
    expect(result.health.summary).toEqual({});
    expect(world.mailer.messages).toHaveLength(0);
  });

  it("does not print or return the key, whatever the deployment answers", async () => {
    const world = await stagingWorld();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await runSpike({ baseUrl: BASE, apiKey: world.key, cronSecret: SECRET, count: 2, fetchImpl: world.fetchImpl, runId: "t4" });
    log.mockRestore();
    expect(JSON.stringify(result)).not.toContain(world.key);
  });
});

describe("getCronDeps", () => {
  it("is not needed here: the handler takes whatever deps it is given", () => {
    expect(typeof getCronDeps).toBe("function");
  });
});
