import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RateLimiter, RateResult } from "@/lib/ratelimit/limiter";

/** Behaviour every limiter must have, checked with one identifier and a small limit. */
export async function runLimiterCheck(
  limiter: RateLimiter,
  identifier: string,
  limit = 3,
): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const record = (pass: boolean, text: string) => {
    lines.push(`${pass ? "PASS" : "FAIL"}  ${text}`);
    if (!pass) ok = false;
  };

  const first: RateResult[] = [];
  for (let i = 0; i < limit; i++) first.push(await limiter.check(identifier, limit));
  record(first.every((r) => r.allowed), `the first ${limit} requests are allowed`);
  record(first.every((r, i) => r.remaining === limit - 1 - i), "remaining counts down to 0");

  const refused = await limiter.check(identifier, limit);
  record(!refused.allowed, `request ${limit + 1} is refused`);
  record(
    refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60,
    "the refusal carries a retry-after of 1 to 60 seconds",
  );

  const other = await limiter.check(`${identifier}:other`, limit);
  record(other.allowed, "a different identifier is not affected");

  return { ok, lines };
}

async function main(): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must both be set");

  const { Redis } = await import("@upstash/redis");
  const { createUpstashLimiter } = await import("@/lib/ratelimit/upstash");
  const redis = new Redis({ url, token });

  const lines: string[] = [];
  let ok = true;
  const record = (pass: boolean, text: string) => {
    lines.push(`${pass ? "PASS" : "FAIL"}  ${text}`);
    if (!pass) ok = false;
  };

  // The limiter falls back to memory when Upstash is unreachable, so prove Redis answers on its own.
  try {
    await redis.ping();
    record(true, "Upstash Redis is reachable");
  } catch {
    record(false, "Upstash Redis is not reachable (check the URL and token)");
    for (const line of lines) console.log(line);
    process.exitCode = 1;
    return;
  }

  const stamp = `live-check:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  try {
    const first = createUpstashLimiter(url, token);
    const second = createUpstashLimiter(url, token);

    const basic = await runLimiterCheck(first, stamp, 3);
    lines.push(...basic.lines);
    if (!basic.ok) ok = false;

    const stored = await redis.keys(`agent-court:rl:${stamp}*`);
    record(stored.length > 0, "request counters are stored in Redis, not in this process");

    // Two limiter instances stand in for two serverless instances: they must share one count.
    const shared = `${stamp}:shared`;
    await first.check(shared, 3);
    await first.check(shared, 3);
    const third = await second.check(shared, 3);
    const fourth = await second.check(shared, 3);
    record(third.allowed && !fourth.allowed, "a second limiter instance sees the same counters");
  } catch (error) {
    record(false, `a Redis command failed: ${error instanceof Error ? error.message : "unknown error"}`);
    lines.push(
      "HINT  NOPERM means the token cannot run these commands. Use the standard read-write REST token, not the read-only one (read-only tokens start with 'gg').",
    );
  }

  try {
    const leftovers = await redis.keys(`agent-court:rl:${stamp}*`);
    if (leftovers.length > 0) await redis.del(...leftovers);
  } catch {
    // Best-effort cleanup only.
  }

  for (const line of lines) console.log(line);
  console.log(ok ? `\nAll ${lines.length} checks passed.` : "\nSome checks FAILED.");
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "live rate limit check failed");
    process.exitCode = 1;
  });
}
