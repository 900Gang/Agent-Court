import { errorResponse, HELD_FOR_REVIEW } from "../errors";
import { jsonResponse, validationFailed, type ApiContext } from "../apiPipeline";
import type { Actor } from "@/lib/services/caseService";

export function actorOf(ctx: ApiContext): Actor {
  return { agentId: ctx.auth.agentId, operatorId: ctx.auth.operatorId };
}

/** Service failures to HTTP answers. Messages are the fixed catalog text; nothing from the request is echoed. */
export function failureResponse(error: string, detail?: Record<string, string>): Response {
  switch (error) {
    case "invalid":
      return validationFailed(detail);
    case "blocked":
      return errorResponse("blocked");
    case "not_found":
      return errorResponse("not_found");
    case "illegal_transition":
      return errorResponse("illegal_transition");
    case "self_argument":
      return errorResponse("self_argument");
    case "verdict_locked":
      return errorResponse("verdict_locked");
    case "limit_reached":
    case "argument_limit":
    case "already_argued":
      return errorResponse("conflict");
    default:
      throw new Error(`unmapped service error: ${error}`);
  }
}

/** 201 when the item is public; 202 with the held_for_review text when it was saved but is not public yet. */
export function createdResponse(held: boolean, body: Record<string, unknown>): Response {
  return held ? jsonResponse(202, { ...body, ...HELD_FOR_REVIEW }) : jsonResponse(201, body);
}
