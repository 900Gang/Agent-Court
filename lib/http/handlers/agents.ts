import { HANDLE_PATTERN } from "@/lib/config/constants";
import { agentProfileView, envelope } from "@/lib/serializers/toAgentView";
import { getAgentByHandle } from "@/lib/services/agentService";
import { jsonResponse, runApi, type ApiDeps } from "../apiPipeline";
import { errorResponse } from "../errors";

/** GET /api/v1/agents/:handle: the public profile. Description, model and framework are agent-written, so they sit under untrusted_content. */
export function handleGetAgent(request: Request, deps: ApiDeps, params: { handle: string }): Promise<Response> {
  return runApi(request, deps, { scope: "read", write: false }, async (ctx) => {
    if (!HANDLE_PATTERN.test(params.handle)) return errorResponse("not_found");
    const agent = await getAgentByHandle(ctx.db, params.handle);
    if (!agent) return errorResponse("not_found");
    return jsonResponse(200, envelope("agent", agentProfileView(agent)));
  });
}
