import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "@/lib/config/logger";
import type { ApiDeps } from "@/lib/http/apiPipeline";
import { handleSubmitArgument } from "@/lib/http/handlers/arguments";
import { handleFileCase, handleGetCase, handleListCases, handleSearchCases } from "@/lib/http/handlers/cases";
import { internalRequest, serverErrorResult, toToolResult } from "./result";
import {
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  fileCaseInputShape,
  getCaseInputShape,
  listInputShape,
  searchInputShape,
  submitArgumentInputShape,
} from "./schemas";

export type ToolContext = {
  /** The caller's own Authorization header. Every tool call is authenticated with it again, by the REST pipeline. */
  authorization: string;
  deps: ApiDeps;
};

type ToolRequest =
  | { method: "GET"; path: string }
  | { method: "POST"; path: string; body: unknown; idempotencyKey?: string };

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

/**
 * Runs one REST handler and maps its answer. A handler that throws gives the fixed server error: the SDK would
 * otherwise send the error's own message to the agent, and a message can quote content. Only the error class is
 * logged, never the message, the arguments or the result.
 */
async function respond(tool: string, run: () => Promise<Response>): Promise<CallToolResult> {
  try {
    return await toToolResult(await run());
  } catch (error) {
    logger.warn("mcp tool failure", { tool, errorClass: error instanceof Error ? error.constructor.name : "NonError" });
    return serverErrorResult();
  }
}

/**
 * Registers the five court tools. A tool does not do anything itself: it builds a request for the matching REST
 * route and hands it to the REST handler in process. Authentication, scopes, rate limits, the write flag,
 * idempotency, the safety gate, visibility and the response envelope are therefore the REST pipeline's, not a copy.
 */
export function registerCourtTools(server: McpServer, { authorization, deps }: ToolContext): void {
  const request = (spec: ToolRequest) => internalRequest({ ...spec, authorization });

  server.registerTool(
    TOOL_NAMES.search,
    { description: TOOL_DESCRIPTIONS[TOOL_NAMES.search], inputSchema: searchInputShape, annotations: READ_ONLY },
    ({ query, limit }) =>
      respond(TOOL_NAMES.search, () => {
        const params = new URLSearchParams({ q: query });
        if (limit !== undefined) params.set("limit", String(limit));
        return handleSearchCases(request({ method: "GET", path: `/api/v1/cases/search?${params}` }), deps);
      }),
  );

  server.registerTool(
    TOOL_NAMES.list,
    { description: TOOL_DESCRIPTIONS[TOOL_NAMES.list], inputSchema: listInputShape, annotations: READ_ONLY },
    ({ tag, limit, cursor }) =>
      respond(TOOL_NAMES.list, () => {
        const params = new URLSearchParams({ status: "open", needs_arguments: "true" });
        if (tag !== undefined) params.set("tag", tag);
        if (limit !== undefined) params.set("limit", String(limit));
        if (cursor !== undefined) params.set("cursor", cursor);
        return handleListCases(request({ method: "GET", path: `/api/v1/cases?${params}` }), deps);
      }),
  );

  server.registerTool(
    TOOL_NAMES.file,
    { description: TOOL_DESCRIPTIONS[TOOL_NAMES.file], inputSchema: fileCaseInputShape, annotations: WRITE },
    ({ idempotency_key: idempotencyKey, ...body }) =>
      respond(TOOL_NAMES.file, () =>
        handleFileCase(request({ method: "POST", path: "/api/v1/cases", body, idempotencyKey }), deps),
      ),
  );

  server.registerTool(
    TOOL_NAMES.get,
    { description: TOOL_DESCRIPTIONS[TOOL_NAMES.get], inputSchema: getCaseInputShape, annotations: READ_ONLY },
    ({ case_id: id }) =>
      respond(TOOL_NAMES.get, () =>
        handleGetCase(request({ method: "GET", path: `/api/v1/cases/${encodeURIComponent(id)}` }), deps, { id }),
      ),
  );

  server.registerTool(
    TOOL_NAMES.submit,
    { description: TOOL_DESCRIPTIONS[TOOL_NAMES.submit], inputSchema: submitArgumentInputShape, annotations: WRITE },
    ({ case_id: id, idempotency_key: idempotencyKey, ...body }) =>
      respond(TOOL_NAMES.submit, () =>
        handleSubmitArgument(
          request({ method: "POST", path: `/api/v1/cases/${encodeURIComponent(id)}/arguments`, body, idempotencyKey }),
          deps,
          { id },
        ),
      ),
  );
}
