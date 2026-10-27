import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateApiKey } from "@/lib/auth/apiKeyAuth";
import { logger } from "@/lib/config/logger";
import { readJsonBody, validationFailed, type ApiDeps } from "@/lib/http/apiPipeline";
import { errorResponse } from "@/lib/http/errors";
import { checkRequest } from "@/lib/ratelimit/limiter";
import { TOOL_NAMES } from "./schemas";
import { createCourtServer } from "./server";

// Only these are ever written to a log. Anything else a client puts in `method` or in a tool name is logged as
// "other", so a log line can never carry client-chosen text.
const KNOWN_METHODS = new Set(["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"]);
const KNOWN_TOOLS = new Set<string>(Object.values(TOOL_NAMES));

type Seen = { method?: string; tool?: string };

async function serve(request: Request, deps: ApiDeps, seen: Seen): Promise<Response> {
  // A browser always sends Origin; the agent clients this endpoint is for do not. Refusing it closes the browser
  // and DNS-rebinding path, and it comes first so a web page learns nothing about keys.
  if (request.headers.has("origin")) return errorResponse("origin_not_allowed");
  if (request.method !== "POST") return errorResponse("method_not_allowed", { Allow: "POST" });

  const now = deps.now ?? new Date();
  const authenticated = await authenticateApiKey(deps.db, request.headers.get("authorization"), now);
  if (!authenticated.ok) return errorResponse(authenticated.code);

  const body = await readJsonBody(request);
  if (!body.ok) return validationFailed(body.detail);
  const message = body.value as Record<string, unknown>;

  const method = typeof message.method === "string" ? message.method : undefined;
  seen.method = method === undefined ? undefined : KNOWN_METHODS.has(method) ? method : "other";
  if (method === "tools/call") {
    const params = message.params as { name?: unknown } | undefined;
    seen.tool = typeof params?.name === "string" && KNOWN_TOOLS.has(params.name) ? params.name : "other";
  }

  // A tools/call is counted once, by the REST pipeline it goes through. Every other message is counted once here.
  if (method !== "tools/call") {
    const limit = await checkRequest(deps.limiter, authenticated.auth, { now });
    if (!limit.allowed) return errorResponse("rate_limited", limit.headers);
  }

  // Stateless: a fresh server and transport for every request, no session id, plain JSON back.
  const server = createCourtServer({ authorization: request.headers.get("authorization") ?? "", deps });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody: body.value });
  } finally {
    await server.close();
  }
}

/**
 * POST /mcp. In order: Origin, method, key, body, rate limit, then the SDK transport. The log line holds the method,
 * the tool name and the status, and never an argument or a result (T10).
 */
export async function handleMcp(request: Request, deps: ApiDeps): Promise<Response> {
  const seen: Seen = {};
  const response = await serve(request, deps, seen);
  logger.info("mcp request", { method: seen.method, tool: seen.tool, status: response.status });
  return response;
}
