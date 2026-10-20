import { beforeEach, describe, expect, it } from "vitest";
import { checkRequest, type RateLimiter } from "@/lib/ratelimit/limiter";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import { resolveLimits } from "@/lib/ratelimit/quotas";

const DAY = 86_400_000;
const START = Date.parse("2026-10-20T00:00:00Z");
let clock = START;

beforeEach(() => {
  clock = START;
});

const memory = () => createMemoryLimiter(() => clock);
const old = new Date(START - 30 * DAY);
const young = new Date(START - 1 * DAY);

let counter = 0;
const authFor = (overrides: Partial<{ keyId: string; operatorId: string; agentCreatedAt: Date }> = {}) => ({
  keyId: `key-${++counter}`,
  operatorId: "op-1",
  agentCreatedAt: old,
  ...overrides,
});

function call(
  limiter: RateLimiter,
  auth: ReturnType<typeof authFor>,
  options: { tier?: number } = {},
) {
  return checkRequest(limiter, auth, { now: new Date(clock), ...options });
}

describe("createMemoryLimiter", () => {
  it("allows exactly `limit` requests, counting remaining down, then denies", async () => {
    const limiter = memory();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.check("a", 3));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results.every((r) => r.limit === 3)).toBe(true);
    expect(results[3].retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(results[3].retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("reports when the oldest request leaves the window", async () => {
    const limiter = memory();
    await limiter.check("a", 3); // t = 0
    clock = START + 10_000;
    await limiter.check("a", 3);
    clock = START + 20_000;
    await limiter.check("a", 3);
    clock = START + 25_000;
    const denied = await limiter.check("a", 3);
    expect(denied.allowed).toBe(false);
    expect(denied.resetAt).toBe(START + 60_000);
    expect(denied.retryAfterSeconds).toBe(35);
  });

  it("reports a reset 60 seconds away for the first request", async () => {
    const first = await memory().check("a", 3);
    expect(first.resetAt).toBe(START + 60_000);
    expect(first.retryAfterSeconds).toBe(0);
  });

  it("frees a slot at exactly 60 seconds, not before", async () => {
    const limiter = memory();
    for (let i = 0; i < 3; i++) await limiter.check("a", 3);
    clock = START + 59_999;
    expect((await limiter.check("a", 3)).allowed).toBe(false);
    clock = START + 60_000;
    expect((await limiter.check("a", 3)).allowed).toBe(true);
  });

  it("slides: slots free one at a time as old requests age out", async () => {
    const limiter = memory();
    await limiter.check("a", 3); // t = 0
    clock = START + 10_000;
    await limiter.check("a", 3);
    clock = START + 20_000;
    await limiter.check("a", 3);

    clock = START + 60_000; // only the first has aged out
    expect((await limiter.check("a", 3)).allowed).toBe(true);
    expect((await limiter.check("a", 3)).allowed).toBe(false);
    clock = START + 70_000; // the second has aged out
    expect((await limiter.check("a", 3)).allowed).toBe(true);
    expect((await limiter.check("a", 3)).allowed).toBe(false);
  });

  it("does not count denied requests against the window", async () => {
    const limiter = memory();
    for (let i = 0; i < 3; i++) await limiter.check("a", 3);
    clock = START + 30_000;
    for (let i = 0; i < 100; i++) expect((await limiter.check("a", 3)).allowed).toBe(false);
    clock = START + 60_000;
    expect((await limiter.check("a", 3)).allowed).toBe(true);
  });

  it("keeps identifiers independent", async () => {
    const limiter = memory();
    for (let i = 0; i < 3; i++) await limiter.check("a", 3);
    expect((await limiter.check("a", 3)).allowed).toBe(false);
    expect((await limiter.check("b", 3)).allowed).toBe(true);
  });

  it("applies the limit given at check time to the same history", async () => {
    const limiter = memory();
    await limiter.check("a", 5);
    await limiter.check("a", 5);
    expect((await limiter.check("a", 2)).allowed).toBe(false);
    expect((await limiter.check("a", 3)).allowed).toBe(true);
  });

  it("denies everything when the limit is zero", async () => {
    const result = await memory().check("a", 0);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBe(60);
  });
});

describe("resolveLimits", () => {
  const now = new Date(START);

  it("gives an established agent the base limits", () => {
    expect(resolveLimits({ agentCreatedAt: old, now })).toEqual({ perKey: 60, perOperator: 120 });
  });

  it("gives a new agent lower limits until it is exactly 7 days old", () => {
    const newLimits = { perKey: 30, perOperator: 60 };
    expect(resolveLimits({ agentCreatedAt: new Date(START - 6 * DAY - 23 * 3_600_000), now })).toEqual(newLimits);
    expect(resolveLimits({ agentCreatedAt: new Date(START - 7 * DAY + 1), now })).toEqual(newLimits);
    expect(resolveLimits({ agentCreatedAt: new Date(START - 7 * DAY), now })).toEqual({ perKey: 60, perOperator: 120 });
  });

  it("treats a creation date in the future as a new agent", () => {
    expect(resolveLimits({ agentCreatedAt: new Date(START + DAY), now })).toEqual({ perKey: 30, perOperator: 60 });
  });

  it("multiplies by 1 + tier", () => {
    expect(resolveLimits({ agentCreatedAt: old, tier: 1, now })).toEqual({ perKey: 120, perOperator: 240 });
    expect(resolveLimits({ agentCreatedAt: old, tier: 2, now })).toEqual({ perKey: 180, perOperator: 360 });
    expect(resolveLimits({ agentCreatedAt: young, tier: 1, now })).toEqual({ perKey: 60, perOperator: 120 });
  });

  it("rounds down, and treats a negative tier as 0", () => {
    expect(resolveLimits({ agentCreatedAt: young, tier: 0.5, now })).toEqual({ perKey: 45, perOperator: 90 });
    expect(resolveLimits({ agentCreatedAt: old, tier: -3, now })).toEqual({ perKey: 60, perOperator: 120 });
  });

  it("defaults to tier 0", () => {
    expect(resolveLimits({ agentCreatedAt: old, now })).toEqual(resolveLimits({ agentCreatedAt: old, tier: 0, now }));
  });
});

describe("checkRequest", () => {
  it("allows 60 requests per key, then denies with denied = key", async () => {
    const limiter = memory();
    const auth = authFor();
    for (let i = 0; i < 60; i++) expect((await call(limiter, auth)).allowed).toBe(true);
    const denied = await call(limiter, auth);
    expect(denied).toMatchObject({ allowed: false, denied: "key" });
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(denied.headers["Retry-After"]).toBe(String(denied.retryAfterSeconds));
    expect(denied.headers["RateLimit-Limit"]).toBe("60");
    expect(denied.headers["RateLimit-Remaining"]).toBe("0");
  });

  it("gives a new agent lower limits", async () => {
    const limiter = memory();
    const auth = authFor({ agentCreatedAt: young });
    for (let i = 0; i < 30; i++) expect((await call(limiter, auth)).allowed).toBe(true);
    expect(await call(limiter, auth)).toMatchObject({ allowed: false, denied: "key" });
  });

  it("raises the limits with the tier", async () => {
    const limiter = memory();
    const auth = authFor();
    for (let i = 0; i < 120; i++) expect((await call(limiter, auth, { tier: 1 })).allowed).toBe(true);
    expect(await call(limiter, auth, { tier: 1 })).toMatchObject({ allowed: false, denied: "key" });
  });

  it("shares the operator limit across that operator's keys", async () => {
    const limiter = memory();
    const a = authFor();
    const b = authFor();
    const c = authFor();
    for (let i = 0; i < 60; i++) await call(limiter, a);
    for (let i = 0; i < 60; i++) await call(limiter, b);
    const denied = await call(limiter, c);
    expect(denied).toMatchObject({ allowed: false, denied: "operator" });
    expect(denied.headers["RateLimit-Limit"]).toBe("120");
    expect(denied.headers["RateLimit-Remaining"]).toBe("0");
    expect(denied.headers["Retry-After"]).toBeDefined();
  });

  it("does not let a different operator's traffic count", async () => {
    const limiter = memory();
    for (let i = 0; i < 60; i++) await call(limiter, authFor({ operatorId: "op-1" }));
    expect((await call(limiter, authFor({ operatorId: "op-2" }))).allowed).toBe(true);
  });

  it("does not use up the operator's allowance when the key limit refuses the request", async () => {
    const limiter = memory();
    const runaway = authFor();
    for (let i = 0; i < 80; i++) await call(limiter, runaway); // 60 allowed, 20 refused by the key limit
    const other = authFor();
    for (let i = 0; i < 60; i++) expect((await call(limiter, other)).allowed).toBe(true);
    expect(await call(limiter, authFor())).toMatchObject({ allowed: false, denied: "operator" });
  });

  it("returns the full result shape for an allowed request", async () => {
    const result = await call(memory(), authFor());
    expect(result.allowed).toBe(true);
    expect(result.denied).toBeUndefined();
    expect(result.retryAfterSeconds).toBe(0);
    expect(result.headers["Retry-After"]).toBeUndefined();
  });

  it("reports the tighter of the two limits in the headers", async () => {
    const limiter = memory();
    const first = await call(limiter, authFor());
    expect(first.headers).toMatchObject({ "RateLimit-Limit": "60", "RateLimit-Remaining": "59", "RateLimit-Reset": "60" });

    for (let i = 0; i < 49; i++) await call(limiter, authFor()); // 50 operator requests so far, one per key
    const tighter = await call(limiter, authFor());
    // The fresh key has 59 left of 60; the operator has 69 left of 120. The key is tighter.
    expect(tighter.headers["RateLimit-Limit"]).toBe("60");
    expect(tighter.headers["RateLimit-Remaining"]).toBe("59");

    const busy = authFor();
    for (let i = 0; i < 60; i++) await call(limiter, busy);
    const operatorTighter = await call(limiter, authFor());
    expect(operatorTighter.headers["RateLimit-Limit"]).toBe("120");
    expect(Number(operatorTighter.headers["RateLimit-Remaining"])).toBeLessThan(59);
  });

  it("reports whole seconds until reset", async () => {
    const limiter = memory();
    const auth = authFor();
    await call(limiter, auth);
    clock = START + 10_000;
    const second = await call(limiter, auth);
    expect(second.headers["RateLimit-Reset"]).toBe("50");
  });

  it("hands the limiter identifiers made of ids, never a key", async () => {
    const real = memory();
    const seen: Array<{ id: string; limit: number }> = [];
    const spy: RateLimiter = {
      check(id, limit) {
        seen.push({ id, limit });
        return real.check(id, limit);
      },
    };
    await call(spy, authFor({ keyId: "key-uuid-1", operatorId: "op-uuid-1" }));
    expect(seen).toEqual([
      { id: "key:key-uuid-1", limit: 60 },
      { id: "operator:op-uuid-1", limit: 120 },
    ]);
  });

  it("asks for the new-agent limits for a young agent", async () => {
    const real = memory();
    const limits: number[] = [];
    const spy: RateLimiter = {
      check(id, limit) {
        limits.push(limit);
        return real.check(id, limit);
      },
    };
    await call(spy, authFor({ agentCreatedAt: young }));
    expect(limits).toEqual([30, 60]);
  });

  it("does not ask about the operator when the key is already refused", async () => {
    const real = memory();
    const ids: string[] = [];
    const spy: RateLimiter = {
      check(id, limit) {
        ids.push(id);
        return real.check(id, limit);
      },
    };
    const auth = authFor();
    for (let i = 0; i < 60; i++) await call(spy, auth);
    ids.length = 0;
    await call(spy, auth);
    expect(ids).toEqual([`key:${auth.keyId}`]);
  });
});
