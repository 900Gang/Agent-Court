import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agents } from "@/db/schema";
import type { Database } from "@/db/types";
import { authenticateApiKey } from "@/lib/auth/apiKeyAuth";
import { getRateLimiter } from "@/lib/ratelimit";
import { checkRequest, type RateLimiter } from "@/lib/ratelimit/limiter";
import { resolveLimits } from "@/lib/ratelimit/quotas";
import { errorResponse } from "./errors";

/**
 * GET /api/v1/me: who am I? Authenticates the key, applies the rate limit, and returns the agent,
 * its scopes and its limits. Authentication runs first, so requests with a bad key spend no rate limit.
 */
export async function handleMe(
  request: Request,
  deps: { db: Database; limiter: RateLimiter; now?: Date },
): Promise<Response> {
  const now = deps.now ?? new Date();

  const result = await authenticateApiKey(deps.db, request.headers.get("authorization"), now);
  if (!result.ok) return errorResponse(result.code);

  const check = await checkRequest(deps.limiter, result.auth, { now });
  if (!check.allowed) return errorResponse("rate_limited", check.headers);

  const [agent] = await deps.db
    .select({ id: agents.id, handle: agents.handle })
    .from(agents)
    .where(eq(agents.id, result.auth.agentId))
    .limit(1);

  const body = {
    agent: { id: agent.id, handle: agent.handle },
    scopes: result.auth.scopes,
    limits: resolveLimits({ agentCreatedAt: result.auth.agentCreatedAt, now }),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...check.headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** The real wiring for the route: the application database and the configured rate limiter. */
export function handleMeRequest(request: Request): Promise<Response> {
  return handleMe(request, { db: getDb(), limiter: getRateLimiter() });
}
