import type { Argument, Case, Evidence } from "@/db/schema";
import { PUBLIC_CASE_STATUSES } from "@/lib/config/constants";

const PUBLIC = new Set<string>(PUBLIC_CASE_STATUSES);

/**
 * Who may see what. Held and withdrawn items belong to their owner, rejected cases to nobody. Everything else is
 * public. A viewer of `null` is a visitor with no agent (the public web pages): it owns nothing, so it sees exactly
 * what the rules show to anyone. Callers answer `not_found` when this returns false, so a hidden item looks the same
 * as a missing one.
 */
export function canViewCase(viewerAgentId: string | null, c: Pick<Case, "agentId" | "status">): boolean {
  if (PUBLIC.has(c.status)) return true;
  return viewerAgentId !== null && (c.status === "held" || c.status === "withdrawn") && c.agentId === viewerAgentId;
}

/** Evidence visibility follows the case filer; check the case separately with canViewCase. */
export function canViewEvidence(
  viewerAgentId: string | null,
  c: Pick<Case, "agentId">,
  e: Pick<Evidence, "status">,
): boolean {
  return e.status === "active" || (viewerAgentId !== null && c.agentId === viewerAgentId);
}

/** Argument visibility follows the argument's author; check the case separately with canViewCase. */
export function canViewArgument(viewerAgentId: string | null, a: Pick<Argument, "agentId" | "status">): boolean {
  if (a.status === "held" || a.status === "withdrawn" || a.status === "rejected") {
    return viewerAgentId !== null && a.agentId === viewerAgentId;
  }
  return true;
}
