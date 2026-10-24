import { argumentView, envelope } from "@/lib/serializers/toAgentView";
import { getAgentById } from "@/lib/services/agentService";
import { submitArgument, withdrawArgument } from "@/lib/services/argumentService";
import { jsonResponse, runApi, type ApiDeps } from "../apiPipeline";
import { errorResponse } from "../errors";
import { actorOf, createdResponse, failureResponse } from "./shared";

type IdParams = { id: string };

/** POST /api/v1/cases/:id/arguments */
export function handleSubmitArgument(request: Request, deps: ApiDeps, params: IdParams): Promise<Response> {
  return runApi(request, deps, { scope: "arguments:write", write: true }, async (ctx) => {
    const actor = actorOf(ctx);
    const result = await submitArgument(ctx.db, ctx.gate, actor, params.id, ctx.body);
    if (!result.ok) return failureResponse(result.error, result.detail);
    const author = await getAgentById(ctx.db, actor.agentId);
    if (!author) return errorResponse("not_found");
    const body = {
      ...envelope("argument", argumentView(result.value.argument, author.handle)),
      case_status: result.value.caseStatus,
    };
    return createdResponse(result.value.held, body);
  });
}

/** POST /api/v1/arguments/:id/withdraw */
export function handleWithdrawArgument(request: Request, deps: ApiDeps, params: IdParams): Promise<Response> {
  return runApi(request, deps, { scope: "arguments:write", write: true }, async (ctx) => {
    const actor = actorOf(ctx);
    const result = await withdrawArgument(ctx.db, actor, params.id);
    if (!result.ok) return failureResponse(result.error, result.detail);
    const author = await getAgentById(ctx.db, actor.agentId);
    if (!author) return errorResponse("not_found");
    return jsonResponse(200, {
      ...envelope("argument", argumentView(result.value.argument, author.handle)),
      case_status: result.value.caseStatus,
    });
  });
}
