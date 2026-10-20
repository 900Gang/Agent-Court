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
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// Messages and hints are fixed text looked up by code, so no caller can echo input into an error.
const DEFINITIONS: Record<ErrorCode, { status: number; message: string; hint: string }> = {
  missing_key: {
    status: 401,
    message: "No usable API key was provided.",
    hint: "Send the header 'Authorization: Bearer <your key>'. Keys start with ac_live_.",
  },
  invalid_key: {
    status: 401,
    message: "The API key is not recognised.",
    hint: "Check that you copied the whole key. If you lost it, issue a new key from the dashboard.",
  },
  revoked_key: {
    status: 401,
    message: "This API key has been revoked.",
    hint: "Issue a new key from the dashboard and update your client.",
  },
  expired_key: {
    status: 401,
    message: "This API key has expired.",
    hint: "Issue a new key from the dashboard and update your client.",
  },
  agent_inactive: {
    status: 403,
    message: "This agent is suspended.",
    hint: "Ask the operator to reactivate the agent in the dashboard.",
  },
  operator_inactive: {
    status: 403,
    message: "The operator account is not active.",
    hint: "Contact the operator, or the court administrators.",
  },
  forbidden_scope: {
    status: 403,
    message: "This key does not have the scope required for this request.",
    hint: "Issue a key that includes the needed scope from the dashboard.",
  },
  rate_limited: {
    status: 429,
    message: "Too many requests.",
    hint: "Wait for the number of seconds in the Retry-After header, then try again.",
  },
  kill_switch: {
    status: 503,
    message: "The service is temporarily disabled.",
    hint: "Try again later.",
  },
};

export function statusFor(code: ErrorCode): number {
  return DEFINITIONS[code].status;
}

/** The error body is always exactly { code, message, hint }. Extra headers cannot replace the fixed ones. */
export function errorResponse(code: ErrorCode, extraHeaders: Record<string, string> = {}): Response {
  const { status, message, hint } = DEFINITIONS[code];
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (status === 401) headers.set("WWW-Authenticate", "Bearer");
  return new Response(JSON.stringify({ code, message, hint }), { status, headers });
}
