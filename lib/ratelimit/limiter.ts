import { resolveLimits } from "./quotas";

export interface RateResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch milliseconds at which the oldest counted request leaves the window. */
  resetAt: number;
  retryAfterSeconds: number;
}

/** A sliding window of `RATE_LIMIT_WINDOW_SECONDS`. Identifiers are ids, never secrets. */
export interface RateLimiter {
  check(identifier: string, limit: number): Promise<RateResult>;
}

export interface RequestCheck {
  allowed: boolean;
  denied?: "key" | "operator";
  retryAfterSeconds: number;
  headers: Record<string, string>;
}

function headersFor(result: RateResult, now: Date, denied: boolean): Record<string, string> {
  const resetSeconds = Math.max(0, Math.ceil((result.resetAt - now.getTime()) / 1000));
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(resetSeconds),
  };
  if (denied) headers["Retry-After"] = String(result.retryAfterSeconds);
  return headers;
}

/**
 * Checks the key limit, then the operator limit. A request refused by the key limit is never
 * counted against the operator, so one runaway key cannot starve the operator's other keys.
 */
export async function checkRequest(
  limiter: RateLimiter,
  auth: { keyId: string; operatorId: string; agentCreatedAt: Date },
  options: { tier?: number; now?: Date } = {},
): Promise<RequestCheck> {
  const now = options.now ?? new Date();
  const limits = resolveLimits({ agentCreatedAt: auth.agentCreatedAt, tier: options.tier, now });

  const key = await limiter.check(`key:${auth.keyId}`, limits.perKey);
  if (!key.allowed) {
    return { allowed: false, denied: "key", retryAfterSeconds: key.retryAfterSeconds, headers: headersFor(key, now, true) };
  }

  const operator = await limiter.check(`operator:${auth.operatorId}`, limits.perOperator);
  if (!operator.allowed) {
    return {
      allowed: false,
      denied: "operator",
      retryAfterSeconds: operator.retryAfterSeconds,
      headers: headersFor(operator, now, true),
    };
  }

  const tighter = operator.remaining < key.remaining ? operator : key;
  return { allowed: true, retryAfterSeconds: 0, headers: headersFor(tighter, now, false) };
}
