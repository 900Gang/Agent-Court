import { getDb } from "@/db/client";
import type { Database } from "@/db/types";
import { authenticateApiKey, hasScope, type AuthContext } from "@/lib/auth/apiKeyAuth";
import { LIMITS, type ApiScope } from "@/lib/config/constants";
import { getServerEnv } from "@/lib/config/env";
import { getRateLimiter } from "@/lib/ratelimit";
import { checkRequest, type RateLimiter } from "@/lib/ratelimit/limiter";
import type { SafetyGate } from "@/lib/safety/gate";
import { failClosedGate } from "@/lib/safety/stub";
import { parseIdempotencyKey } from "@/lib/schemas/idempotency";
import { fail, ok, type ServiceResult } from "@/lib/services/result";
import { errorResponse } from "./errors";
import { hashRequest, runIdempotent } from "./idempotency";

export type ApiDeps = {
  db: Database;
  limiter: RateLimiter;
  gate: SafetyGate;
  writesEnabled: boolean;
  now?: Date;
};

export type ApiContext = {
  auth: AuthContext;
  /** For writes this is the idempotency transaction: a refused request rolls back everything done through it. */
  db: Database;
  gate: SafetyGate;
  now: Date;
  body: unknown;
  searchParams: URLSearchParams;
};

/** A JSON response that is never cached. Extra headers cannot replace the content type or caching rules. */
export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const merged = new Headers(headers);
  merged.set("Content-Type", "application/json; charset=utf-8");
  merged.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: merged });
}

/** 400 validation_failed. Only field names go into the response, never the submitted values. */
export function validationFailed(detail?: Record<string, string>): Response {
  return errorResponse("validation_failed", {}, Object.keys(detail ?? {}));
}

async function readCappedText(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LIMITS.bodyBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * The JSON object in the request body. An empty body is {}. Anything else that is not a JSON object,
 * a body over the size limit, or a stream that fails halfway is `invalid`. Never throws.
 */
export async function readJsonBody(request: Request): Promise<ServiceResult<unknown, "invalid">> {
  try {
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > LIMITS.bodyBytes) return fail("invalid", { form: "body is too large" });
    const text = await readCappedText(request);
    if (text === null) return fail("invalid", { form: "body is too large" });
    if (text.trim() === "") return ok({});
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return fail("invalid", { form: "must be a JSON object" });
    }
    return ok(parsed);
  } catch {
    return fail("invalid", { form: "could not be read as JSON" });
  }
}

function withRateLimitHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

/**
 * The common path of every agent API route. Order: write flag, authentication, scope, rate limit, then
 * (writes only) body, Idempotency-Key and the idempotent run of the handler. Authentication comes before
 * the rate limit so a bad key spends no one's quota; the rate limit comes before the body so a flood of
 * large bodies is refused cheaply.
 */
export async function runApi(
  request: Request,
  deps: ApiDeps,
  spec: { scope: ApiScope; write: boolean },
  handler: (ctx: ApiContext) => Promise<Response>,
): Promise<Response> {
  if (spec.write && !deps.writesEnabled) return errorResponse("writes_disabled");

  const now = deps.now ?? new Date();
  const authenticated = await authenticateApiKey(deps.db, request.headers.get("authorization"), now);
  if (!authenticated.ok) return errorResponse(authenticated.code);
  const auth = authenticated.auth;
  if (!hasScope(auth, spec.scope)) return errorResponse("forbidden_scope");

  const limit = await checkRequest(deps.limiter, auth, { now });
  if (!limit.allowed) return errorResponse("rate_limited", limit.headers);

  const url = new URL(request.url);
  const context = (db: Database, body: unknown): ApiContext => ({
    auth,
    db,
    gate: deps.gate,
    now,
    body,
    searchParams: url.searchParams,
  });

  if (!spec.write) return withRateLimitHeaders(await handler(context(deps.db, {})), limit.headers);

  const body = await readJsonBody(request);
  if (!body.ok) return withRateLimitHeaders(validationFailed(body.detail), limit.headers);
  const key = parseIdempotencyKey(request.headers.get("idempotency-key"));
  if (!key.ok) return withRateLimitHeaders(validationFailed(key.detail), limit.headers);

  const response = await runIdempotent(
    deps.db,
    {
      agentId: auth.agentId,
      key: key.value,
      requestHash: hashRequest(request.method, url.pathname, body.value),
      now,
    },
    (tx) => handler(context(tx, body.value)),
  );
  return withRateLimitHeaders(response, limit.headers);
}

/**
 * The real wiring for route files. The gate is the fail-closed stub until N4, and writes follow
 * API_WRITES_ENABLED, which environment validation refuses in production and staging.
 */
export function getApiDeps(): ApiDeps {
  return {
    db: getDb(),
    limiter: getRateLimiter(),
    gate: failClosedGate,
    writesEnabled: getServerEnv().apiWritesEnabled,
  };
}
