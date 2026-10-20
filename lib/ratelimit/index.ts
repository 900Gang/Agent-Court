import { getServerEnv } from "@/lib/config/env";
import type { RateLimiter } from "./limiter";
import { createMemoryLimiter } from "./memory";
import { createUpstashLimiter } from "./upstash";

let instance: RateLimiter | undefined;

/** Upstash when it is configured (required in production and staging), otherwise an in-memory limiter. */
export function getRateLimiter(): RateLimiter {
  if (!instance) {
    const env = getServerEnv();
    instance =
      env.upstashUrl && env.upstashToken
        ? createUpstashLimiter(env.upstashUrl, env.upstashToken)
        : createMemoryLimiter();
  }
  return instance;
}
