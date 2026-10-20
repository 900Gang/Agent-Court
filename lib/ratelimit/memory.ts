import { RATE_LIMIT_WINDOW_SECONDS } from "@/lib/config/constants";
import type { RateLimiter } from "./limiter";

const WINDOW_MS = RATE_LIMIT_WINDOW_SECONDS * 1000;
const SWEEP_AT = 10_000;

/**
 * Sliding-window limiter kept in process memory. Used by tests, by local development without
 * Upstash, and as the fallback when Upstash cannot be reached. Only allowed requests are recorded,
 * so refused requests never push the window out.
 */
export function createMemoryLimiter(clock: () => number = Date.now): RateLimiter {
  const log = new Map<string, number[]>();

  function sweep(now: number): void {
    for (const [identifier, times] of log) {
      if (times.every((time) => time <= now - WINDOW_MS)) log.delete(identifier);
    }
  }

  return {
    async check(identifier, limit) {
      const now = clock();
      const live = (log.get(identifier) ?? []).filter((time) => time > now - WINDOW_MS);

      if (live.length < limit) {
        live.push(now);
        log.set(identifier, live);
        if (log.size > SWEEP_AT) sweep(now);
        return {
          allowed: true,
          limit,
          remaining: limit - live.length,
          resetAt: live[0] + WINDOW_MS,
          retryAfterSeconds: 0,
        };
      }

      if (live.length === 0) log.delete(identifier);
      else log.set(identifier, live);
      const resetAt = live.length > 0 ? live[0] + WINDOW_MS : now + WINDOW_MS;
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      };
    },
  };
}
