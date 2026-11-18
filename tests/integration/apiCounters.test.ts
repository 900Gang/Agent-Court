import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiScope } from "@/lib/config/constants";
import { jsonResponse, runApi, type ApiDeps } from "@/lib/http/apiPipeline";
import { createCounters, createMemoryCounters, type CounterStore, type Counters } from "@/lib/metrics/counters";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import { issueKey } from "@/lib/services/keyService";
import { passGate } from "../helpers/gates";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

// N10 Task 3 (AC-1005, AC-1006): runApi counts authenticated requests and the ones it answers with 429.

let t: TestDb;
let f: ReturnType<typeof createFixtures>;
const DAY = 86_400_000;
const now = new Date(Date.now() + 30 * DAY);

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

async function setup(scopes: ApiScope[] = ["read", "cases:write", "arguments:write"]) {
  const made = await f.makeAgent();
  const issued = f.unwrap(await issueKey(t.db, made.operator, made.agent.id, { scopes }));
  return { ...made, key: issued.key };
}

const deps = (counters: Counters | undefined, over: Partial<ApiDeps> = {}): ApiDeps => ({
  db: t.db,
  limiter: createMemoryLimiter(() => now.getTime()),
  gate: passGate,
  writesEnabled: true,
  now,
  ...(counters ? { counters } : {}),
  ...over,
});

const get = (key: string | null) => new Request("http://localhost:3000/api/v1/me", { headers: key ? { authorization: `Bearer ${key}` } : {} });
const answer = async () => jsonResponse(200, { ok: true });
const read = { scope: "read", write: false } as const;
const total = async (counters: Counters, kind: "requests" | "rate_limited") => (await counters.read(kind, 1))[0];

describe("runApi counters", () => {
  it("counts an authenticated request", async () => {
    const a = await setup();
    const counters = createMemoryCounters();
    expect((await runApi(get(a.key), deps(counters), read, answer)).status).toBe(200);
    expect(await total(counters, "requests")).toBe(1);
    expect(await total(counters, "rate_limited")).toBe(0);
  });

  it("does not count a request with no key or a wrong key", async () => {
    const counters = createMemoryCounters();
    await runApi(get(null), deps(counters), read, answer);
    await runApi(get("ac_live_" + "x".repeat(32)), deps(counters), read, answer);
    expect(await total(counters, "requests")).toBe(0);
  });

  it("does not count a request that lacks the scope", async () => {
    const a = await setup(["read"]);
    const counters = createMemoryCounters();
    const response = await runApi(get(a.key), deps(counters), { scope: "cases:write", write: false }, answer);
    expect(response.status).toBe(403);
    expect(await total(counters, "requests")).toBe(0);
  });

  it("counts every 429 as a request and as a 429", async () => {
    const a = await setup();
    const counters = createMemoryCounters();
    const limiter = createMemoryLimiter(() => now.getTime());
    const statuses: number[] = [];
    for (let index = 0; index < 70; index += 1) {
      statuses.push((await runApi(get(a.key), deps(counters, { limiter }), read, answer)).status);
    }
    const limited = statuses.filter((status) => status === 429).length;
    expect(limited).toBeGreaterThan(0);
    expect(await total(counters, "requests")).toBe(70);
    expect(await total(counters, "rate_limited")).toBe(limited);
  });

  it("works as before when there are no counters", async () => {
    const a = await setup();
    expect((await runApi(get(a.key), deps(undefined), read, answer)).status).toBe(200);
  });

  it("does not fail or change the answer when the counter store is down", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store: CounterStore = {
      incr: async () => {
        throw new Error("redis down");
      },
      mget: async () => [0],
    };
    const a = await setup();
    const response = await runApi(get(a.key), deps(createCounters(store)), read, answer);
    expect(response.status).toBe(200);
  });
});
