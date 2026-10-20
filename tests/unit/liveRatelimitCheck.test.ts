import { describe, expect, it } from "vitest";
import type { RateLimiter, RateResult } from "@/lib/ratelimit/limiter";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import { runLimiterCheck } from "@/scripts/live-ratelimit-check";

const result = (over: Partial<RateResult>): RateResult => ({
  allowed: true,
  limit: 3,
  remaining: 0,
  resetAt: Date.now() + 60_000,
  retryAfterSeconds: 0,
  ...over,
});

describe("runLimiterCheck", () => {
  it("passes for a correct limiter", async () => {
    const outcome = await runLimiterCheck(createMemoryLimiter(), "id-1");
    expect(outcome.ok).toBe(true);
    expect(outcome.lines.length).toBeGreaterThanOrEqual(5);
    for (const line of outcome.lines) expect(line.startsWith("PASS")).toBe(true);
  });

  it("uses a limit of 3 by default and makes limit + 2 calls", async () => {
    const calls: Array<{ id: string; limit: number }> = [];
    const real = createMemoryLimiter();
    const spy: RateLimiter = {
      check(id, limit) {
        calls.push({ id, limit });
        return real.check(id, limit);
      },
    };
    await runLimiterCheck(spy, "id-2");
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.limit === 3)).toBe(true);

    calls.length = 0;
    await runLimiterCheck(spy, "id-3", 2);
    expect(calls).toHaveLength(4);
  });

  it("fails for a limiter that never refuses", async () => {
    const never: RateLimiter = { check: async (_id, limit) => result({ limit, remaining: 1 }) };
    expect((await runLimiterCheck(never, "id-4")).ok).toBe(false);
  });

  it("fails for a limiter that refuses everything", async () => {
    const always: RateLimiter = {
      check: async (_id, limit) => result({ allowed: false, limit, retryAfterSeconds: 30 }),
    };
    expect((await runLimiterCheck(always, "id-5")).ok).toBe(false);
  });

  it("fails when a refusal has no retry-after", async () => {
    const real = createMemoryLimiter();
    const noRetry: RateLimiter = {
      async check(id, limit) {
        const outcome = await real.check(id, limit);
        return outcome.allowed ? outcome : { ...outcome, retryAfterSeconds: 0 };
      },
    };
    expect((await runLimiterCheck(noRetry, "id-6")).ok).toBe(false);
  });

  it("fails when remaining does not count down", async () => {
    const real = createMemoryLimiter();
    const flat: RateLimiter = {
      async check(id, limit) {
        const outcome = await real.check(id, limit);
        return outcome.allowed ? { ...outcome, remaining: limit } : outcome;
      },
    };
    expect((await runLimiterCheck(flat, "id-7")).ok).toBe(false);
  });

  it("fails when one identifier's traffic limits another", async () => {
    const real = createMemoryLimiter();
    const shared: RateLimiter = { check: (_id, limit) => real.check("everyone", limit) };
    expect((await runLimiterCheck(shared, "id-8")).ok).toBe(false);
  });

  it("reports which checks failed", async () => {
    const never: RateLimiter = { check: async (_id, limit) => result({ limit, remaining: 1 }) };
    const outcome = await runLimiterCheck(never, "id-9");
    expect(outcome.lines.some((line) => line.startsWith("FAIL"))).toBe(true);
  });
});
