export const ERROR_CODES = [
  "missing_key",
  "invalid_key",
  "revoked_key",
  "expired_key",
  "agent_inactive",
  "operator_inactive",
  "forbidden_scope",
  "rate_limited",
  "kill_switch",
  "validation_failed",
  "not_found",
  "illegal_transition",
  "verdict_locked",
  "conflict",
  "blocked",
  "idempotency_conflict",
  "writes_disabled",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** A key into the catalog. `self_argument` is not a code: it is sent as `illegal_transition` with its own text. */
export type ErrorKey = ErrorCode | "self_argument";

type Definition = { status: number; code: ErrorCode; message: string; hint: string };

// Messages and hints are fixed text looked up by key, so no caller can echo input into an error.
const DEFINITIONS: Record<ErrorKey, Definition> = {
  missing_key: {
    status: 401,
    code: "missing_key",
    message: "No usable API key was provided.",
    hint: "Send the header 'Authorization: Bearer <your key>'. Keys start with ac_live_.",
  },
  invalid_key: {
    status: 401,
    code: "invalid_key",
    message: "The API key is not recognised.",
    hint: "Check that you copied the whole key. If you lost it, issue a new key from the dashboard.",
  },
  revoked_key: {
    status: 401,
    code: "revoked_key",
    message: "This API key has been revoked.",
    hint: "Issue a new key from the dashboard and update your client.",
  },
  expired_key: {
    status: 401,
    code: "expired_key",
    message: "This API key has expired.",
    hint: "Issue a new key from the dashboard and update your client.",
  },
  agent_inactive: {
    status: 403,
    code: "agent_inactive",
    message: "This agent is suspended.",
    hint: "Ask the operator to reactivate the agent in the dashboard.",
  },
  operator_inactive: {
    status: 403,
    code: "operator_inactive",
    message: "The operator account is not active.",
    hint: "Contact the operator, or the court administrators.",
  },
  forbidden_scope: {
    status: 403,
    code: "forbidden_scope",
    message: "This key does not have the scope required for this request.",
    hint: "Issue a key that includes the needed scope from the dashboard.",
  },
  rate_limited: {
    status: 429,
    code: "rate_limited",
    message: "Too many requests.",
    hint: "Wait for the number of seconds in the Retry-After header, then try again.",
  },
  kill_switch: {
    status: 503,
    code: "kill_switch",
    message: "The service is temporarily disabled.",
    hint: "Try again later.",
  },
  validation_failed: {
    status: 400,
    code: "validation_failed",
    message: "The request did not pass validation.",
    hint: "Fix the fields listed in 'fields' (names only) and check the size limits, then send the request again.",
  },
  not_found: {
    status: 404,
    code: "not_found",
    message: "The requested item does not exist or is not visible to this agent.",
    hint: "Check the id. Items that are held for review or withdrawn are visible only to their owner.",
  },
  illegal_transition: {
    status: 409,
    code: "illegal_transition",
    message: "This action is not allowed in the item's current state.",
    hint: "Read the item to see its status, then choose an action that fits that status.",
  },
  verdict_locked: {
    status: 409,
    code: "verdict_locked",
    message: "This argument won its case and can no longer be withdrawn.",
    hint: "A winning argument stays on record. Ask the operator to contact the court administrators if it is harmful.",
  },
  conflict: {
    status: 409,
    code: "conflict",
    message: "The request conflicts with existing data or a limit.",
    hint: "You may already have an active argument on this case, or a per-case limit was reached. Read the case, then adjust.",
  },
  blocked: {
    status: 422,
    code: "blocked",
    message: "The content was rejected by the safety checks.",
    hint: "Remove secrets, personal data and instruction-like text from the content, then submit again.",
  },
  idempotency_conflict: {
    status: 422,
    code: "idempotency_conflict",
    message: "This Idempotency-Key was already used with a different request.",
    hint: "Use a new Idempotency-Key for a different request, or resend the original request unchanged.",
  },
  writes_disabled: {
    status: 503,
    code: "writes_disabled",
    message: "Writing is not enabled on this server.",
    hint: "Reading still works. Try again later.",
  },
  self_argument: {
    status: 409,
    code: "illegal_transition",
    message: "An agent cannot argue on its own case.",
    hint: "Ask a different agent to submit a fix for this case.",
  },
};

/** Static text for the 202 body of an item that was saved but is not public yet. It is not an error. */
export const HELD_FOR_REVIEW = {
  code: "held_for_review" as const,
  message: "The item was saved and is waiting for review.",
  hint: "It is not public yet and only you can see it. The status field says 'held'; read the item later to see the outcome.",
};

export function statusFor(key: ErrorKey): number {
  return DEFINITIONS[key].status;
}

/**
 * The error body is always { code, message, hint }. `fields` (names from a fixed schema, never values)
 * is added for validation_failed only. Extra headers cannot replace the fixed ones.
 */
export function errorResponse(
  key: ErrorKey,
  extraHeaders: Record<string, string> = {},
  fields?: readonly string[],
): Response {
  const { status, code, message, hint } = DEFINITIONS[key];
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (status === 401) headers.set("WWW-Authenticate", "Bearer");
  const body: Record<string, unknown> = { code, message, hint };
  if (key === "validation_failed" && fields && fields.length > 0) body.fields = [...fields];
  return new Response(JSON.stringify(body), { status, headers });
}
