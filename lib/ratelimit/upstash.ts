import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { RATE_LIMIT_WINDOW_SECONDS } from "@/lib/config/constants";
import { logger } from "@/lib/config/logger";
import type { RateLimiter } from "./limiter";
import { createMemoryLimiter } from "./memory";

/**
 * Sliding-window limiter on Upstash Redis. If Upstash cannot be reached, requests fall back to a
 * per-process window and the error is logged: the API stays up and flooding is still limited.
 */
export function createUpstashLimiter(url: string, token: string): RateLimiter {
  const redis = new Redis({ url, token });
  const fallback = createMemoryLimiter();
  const byLimit = new Map<number, Ratelimit>();

  function forLimit(limit: number): Ratelimit {
    let limiter = byLimit.get(limit);
    if (!limiter) {
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(limit, `${RATE_LIMIT_WINDOW_SECONDS} s`),
        prefix: "agent-court:rl",
        analytics: false,
      });
      byLimit.set(limit, limiter);
    }
    return limiter;
  }

  return {
    async check(identifier, limit) {
      if (limit <= 0) return fallback.check(identifier, limit);
      try {
        const result = await forLimit(limit).limit(identifier);
        return {
          allowed: result.success,
          limit: result.limit,
          remaining: Math.max(0, result.remaining),
          resetAt: result.reset,
          retryAfterSeconds: result.success ? 0 : Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
        };
      } catch (error) {
        logger.error("rate limiter unreachable, using in-process fallback", { error });
        return fallback.check(identifier, limit);
      }
    },
  };
}
