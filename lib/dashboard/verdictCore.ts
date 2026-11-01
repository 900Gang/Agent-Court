import { failure, guard, type ActionDeps, type ActionResult } from "@/lib/dashboard/actionsCore";
import { createGate } from "@/lib/safety/engine";
import { issueVerdict } from "@/lib/services/verdictService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

export type IssuedVerdict = {
  caseId: string;
  level: "operator_confirmed" | "self_resolved";
  points: number;
  releaseAt: string | null;
};

/**
 * Issues a verdict for the signed-in operator. The origin is checked first, then that someone is signed in, then the
 * service decides. Every refusal is a fixed message and writes nothing. The service's not_found and illegal_transition
 * become case_not_found and case_not_open, whose texts talk about cases and not about the admin queue.
 */
export async function issueVerdictCore(deps: ActionDeps, formData: FormData): Promise<ActionResult<IssuedVerdict>> {
  const guarded = guard(deps);
  if ("failure" in guarded) return guarded.failure;
  const result = await issueVerdict(
    deps.db,
    createGate(),
    guarded.operator,
    { caseId: text(formData, "caseId"), winningArgumentId: text(formData, "winningArgumentId"), note: text(formData, "note") },
    deps.now,
  );
  if (!result.ok) {
    const code = result.error === "not_found" ? "case_not_found" : result.error === "illegal_transition" ? "case_not_open" : result.error;
    return failure(code, result.detail);
  }
  const { caseId, level, points, releaseAt } = result.value;
  return { ok: true, value: { caseId, level, points, releaseAt: releaseAt === null ? null : releaseAt.toISOString() } };
}

/**
 * Where to send the browser after a verdict. A success goes to the list with one of two fixed words. A refusal goes
 * back to the form of the case that was submitted, but only when that is a UUID checked here; anything else goes to
 * the list. Every path is built from fixed text and a checked UUID, so it can only ever stay on this site.
 */
export function verdictRedirect(result: ActionResult<{ caseId: string; level: string }>, submittedCaseId: string): string {
  if (result.ok) return result.value.level === "self_resolved" ? "/dashboard/cases?verdict=self_resolved" : "/dashboard/cases?verdict=ok";
  const code = encodeURIComponent(result.error.code);
  return UUID.test(submittedCaseId) ? `/dashboard/cases/${submittedCaseId}/verdict?error=${code}` : `/dashboard/cases?error=${code}`;
}
