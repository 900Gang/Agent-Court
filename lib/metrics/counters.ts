import { OPS } from "@/lib/config/constants";
import { logger } from "@/lib/config/logger";
import { safeErrorFields } from "@/lib/config/safeError";

// Request counters for the metrics page and the alert check (N10). Two numbers per hour: authenticated API requests, and
// the ones answered 429. They live in Redis, not in the database, so a flood cannot become a flood of writes. Each key is
// one UTC hour and expires after OPS.counterTtlDays. A counter that fails is logged by error class and otherwise
// ignored: a request never fails because a counter did.

export type CounterKind = "requests" | "rate_limited";

export interface CounterStore {
  /** Adds one to the key and sets its time to live, in seconds. */
  incr(key: string, ttlSeconds: number): Promise<void>;
  /** The values of the keys, in order, with 0 for a key that does not exist. */
  mget(keys: string[]): Promise<number[]>;
}

export interface Counters {
  /** Counts one event in the current hour. Never rejects. */
  count(kind: CounterKind): Promise<void>;
  /** The counts for the last `hours` hours, oldest first, the current hour last. Rejects when the store fails. */
  read(kind: CounterKind, hours: number): Promise<number[]>;
}

const HOUR_MS = 3_600_000;
const MAX_HOURS = OPS.counterTtlDays * 24;

const pad = (value: number, width: number) => String(value).padStart(width, "0");

/** The key of the hour that contains the moment, in UTC: agent-court:m:<kind>:<yyyymmddhh>. */
export function bucketKey(kind: CounterKind, at: number): string {
  const date = new Date(at);
  const stamp = `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}${pad(date.getUTCHours(), 2)}`;
  return `agent-court:m:${kind}:${stamp}`;
}

export function createCounters(store: CounterStore, now: () => number = Date.now): Counters {
  return {
    async count(kind) {
      try {
        await store.incr(bucketKey(kind, now()), OPS.counterTtlDays * 86_400);
      } catch (error) {
        logger.warn("counter not recorded", { kind, ...safeErrorFields(error) });
      }
    },
    async read(kind, hours) {
      if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) throw new Error("hours out of range");
      const current = Math.floor(now() / HOUR_MS) * HOUR_MS;
      const keys = Array.from({ length: hours }, (_unused, index) => bucketKey(kind, current - (hours - 1 - index) * HOUR_MS));
      return store.mget(keys);
    },
  };
}

/** An in-process store, for tests and for a machine with no Redis. Keys expire by the clock it is given. */
export function createMemoryStore(now: () => number = Date.now): CounterStore {
  const entries = new Map<string, { value: number; expiresAt: number }>();
  const live = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    async incr(key, ttlSeconds) {
      entries.set(key, { value: (live(key)?.value ?? 0) + 1, expiresAt: now() + ttlSeconds * 1000 });
    },
    async mget(keys) {
      return keys.map((key) => live(key)?.value ?? 0);
    },
  };
}

/** The same counters over an in-process store. */
export function createMemoryCounters(now: () => number = Date.now): Counters {
  return createCounters(createMemoryStore(now), now);
}
