import { parseListQuery } from "@/lib/schemas/pagination";
import { parseSearchQuery } from "@/lib/schemas/search";
import {
  caseDetailView,
  caseListView,
  envelope,
  evidenceView,
  listEnvelope,
} from "@/lib/serializers/toAgentView";
import { addEvidence, fileCase, getCase, listCases, withdrawCase } from "@/lib/services/caseService";
import { searchCases } from "@/lib/services/searchService";
import { jsonResponse, runApi, validationFailed, type ApiDeps } from "../apiPipeline";
import { errorResponse } from "../errors";
import { actorOf, createdResponse, failureResponse } from "./shared";

type IdParams = { id: string };

/** POST /api/v1/cases */
export function handleFileCase(request: Request, deps: ApiDeps): Promise<Response> {
  return runApi(request, deps, { scope: "cases:write", write: true }, async (ctx) => {
    const actor = actorOf(ctx);
    const result = await fileCase(ctx.db, ctx.gate, actor, ctx.body, ctx.now);
    if (!result.ok) return failureResponse(result.error, result.detail);
    const detail = await getCase(ctx.db, actor.agentId, result.value.case.id);
    if (!detail) return errorResponse("not_found");
    return createdResponse(result.value.held, envelope("case", caseDetailView(detail)), result.value.redactions);
  });
}

/** GET /api/v1/cases */
export function handleListCases(request: Request, deps: ApiDeps): Promise<Response> {
  return runApi(request, deps, { scope: "read", write: false }, async (ctx) => {
    const query = parseListQuery(ctx.searchParams);
    if (!query.ok) return validationFailed(query.detail);
    const page = await listCases(ctx.db, ctx.auth.agentId, query.value);
    return jsonResponse(200, listEnvelope(page.items.map(caseListView), page.nextCursor));
  });
}

/** GET /api/v1/cases/search */
export function handleSearchCases(request: Request, deps: ApiDeps): Promise<Response> {
  return runApi(request, deps, { scope: "read", write: false }, async (ctx) => {
    const query = parseSearchQuery(ctx.searchParams);
    if (!query.ok) return validationFailed(query.detail);
    const items = await searchCases(ctx.db, ctx.auth.agentId, query.value);
    return jsonResponse(200, listEnvelope(items.map(caseListView), null));
  });
}

/** GET /api/v1/cases/:id */
export function handleGetCase(request: Request, deps: ApiDeps, params: IdParams): Promise<Response> {
  return runApi(request, deps, { scope: "read", write: false }, async (ctx) => {
    const detail = await getCase(ctx.db, ctx.auth.agentId, params.id);
    if (!detail) return errorResponse("not_found");
    return jsonResponse(200, envelope("case", caseDetailView(detail)));
  });
}

/** POST /api/v1/cases/:id/evidence */
export function handleAddEvidence(request: Request, deps: ApiDeps, params: IdParams): Promise<Response> {
  return runApi(request, deps, { scope: "cases:write", write: true }, async (ctx) => {
    const result = await addEvidence(ctx.db, ctx.gate, actorOf(ctx), params.id, ctx.body);
    if (!result.ok) return failureResponse(result.error, result.detail);
    return createdResponse(
      result.value.held,
      envelope("evidence", evidenceView(result.value.evidence)),
      result.value.redactions,
    );
  });
}

/** POST /api/v1/cases/:id/withdraw */
export function handleWithdrawCase(request: Request, deps: ApiDeps, params: IdParams): Promise<Response> {
  return runApi(request, deps, { scope: "cases:write", write: true }, async (ctx) => {
    const actor = actorOf(ctx);
    const result = await withdrawCase(ctx.db, actor, params.id);
    if (!result.ok) return failureResponse(result.error, result.detail);
    const detail = await getCase(ctx.db, actor.agentId, params.id);
    if (!detail) return errorResponse("not_found");
    return jsonResponse(200, envelope("case", caseDetailView(detail)));
  });
}
