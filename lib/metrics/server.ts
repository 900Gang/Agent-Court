import { Redis } from "@upstash/redis";
import { getServerEnv } from "@/lib/config/env";
import { createCounters, createMemoryCounters, type CounterStore, type Counters } from "./counters";

function createUpstashStore(url: string, token: string): CounterStore {
  const redis = new Redis({ url, token });
  return {
    async incr(key, ttlSeconds) {
      await redis.pipeline().incr(key).expire(key, ttlSeconds).exec();
    },
    async mget(keys) {
      const values = await redis.mget<Array<number | string | null>>(...keys);
      return values.map((value) => Number(value ?? 0) || 0);
    },
  };
}

let instance: Counters | undefined;

/** Redis when Upstash is configured (as for the rate limiter), otherwise counters in this process. */
export function getCounters(): Counters {
  if (!instance) {
    const env = getServerEnv();
    instance = env.upstashUrl && env.upstashToken ? createCounters(createUpstashStore(env.upstashUrl, env.upstashToken)) : createMemoryCounters();
  }
  return instance;
}
