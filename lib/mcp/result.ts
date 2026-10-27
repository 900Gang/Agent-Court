import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const BASE = "http://mcp.internal";
const API_PREFIX = "/api/v1/";

export type InternalRequestSpec =
  | { method: "GET"; path: string; authorization: string }
  | { method: "POST"; path: string; authorization: string; body: unknown; idempotencyKey?: string };

/**
 * The URL for a REST handler. Only a path under /api/v1/ on our own placeholder host is allowed, so a tool can
 * never be pointed at another origin, another area of the app (admin, cron) or a path that climbs out of the API.
 */
function resolve(path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("unsafe path");
  const url = new URL(path, BASE);
  if (url.origin !== BASE || !url.pathname.startsWith(API_PREFIX)) throw new Error("unsafe path");
  return url;
}

/**
 * A request for the matching REST route, to be handed to the REST handler in process. It carries the caller's own
 * Authorization header and nothing else that could be a credential, so the pipeline authenticates, checks the
 * scope and counts the call exactly as it would for a direct request.
 */
export function internalRequest(spec: InternalRequestSpec): Request {
  const url = resolve(spec.path);
  const headers = new Headers({ authorization: spec.authorization });
  if (spec.method === "GET") return new Request(url, { method: "GET", headers });

  headers.set("content-type", "application/json");
  if (spec.idempotencyKey !== undefined) headers.set("idempotency-key", spec.idempotencyKey);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(spec.body) });
}

// Fixed text, like every error we send. Used when a handler answers with something that is not a JSON object.
const SERVER_ERROR = {
  code: "server_error",
  message: "The court could not complete the request.",
  hint: "Try again later.",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asResult = (body: Record<string, unknown>, isError: boolean): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  structuredContent: body,
  ...(isError ? { isError: true } : {}),
});

/**
 * Turns a REST response into a tool result. The body is the REST body, unchanged: same envelope, same fixed error
 * text, same hints. A 2xx (including 202 held_for_review) is a success; anything else is an error. A 429 also says
 * how long to wait, as a number. A response that is not a JSON object becomes the fixed server error, and its
 * content is dropped.
 */
export async function toToolResult(response: Response): Promise<CallToolResult> {
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return asResult(SERVER_ERROR, true);
  }
  if (!isRecord(body)) return asResult(SERVER_ERROR, true);

  const retryAfter = response.status === 429 ? response.headers.get("retry-after") : null;
  const wait = retryAfter !== null && /^[0-9]+$/.test(retryAfter) ? Number(retryAfter) : null;
  return asResult(wait === null ? body : { ...body, retry_after_seconds: wait }, !response.ok);
}
