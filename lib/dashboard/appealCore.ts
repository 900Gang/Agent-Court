import { failure, guard, type ActionDeps, type ActionResult } from "@/lib/dashboard/actionsCore";
import { createGate } from "@/lib/safety/engine";
import { appealVerdict } from "@/lib/services/verdictService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/**
 * Files an appeal for the signed-in operator. The origin is checked first, then that someone is signed in, then the
 * service decides. Every refusal is a fixed message and writes nothing. The service's not_found and illegal_transition
 * become case_not_found and case_not_resolved, whose texts talk about cases.
 */
export async function appealCore(deps: ActionDeps, formData: FormData): Promise<ActionResult<{ caseId: string }>> {
  const guarded = guard(deps);
  if ("failure" in guarded) return guarded.failure;
  const result = await appealVerdict(
    deps.db,
    createGate(),
    guarded.operator,
    { caseId: text(formData, "caseId"), reason: text(formData, "reason") },
    deps.now,
  );
  if (!result.ok) {
    const code = result.error === "not_found" ? "case_not_found" : result.error === "illegal_transition" ? "case_not_resolved" : result.error;
    return failure(code, result.detail);
  }
  return { ok: true, value: { caseId: result.value.caseId } };
}

/**
 * Where to send the browser after an appeal. A success goes to the list with a fixed word. A refusal goes back to the
 * form of the case that was submitted, but only when that is a UUID checked here; anything else goes to the list.
 */
export function appealRedirect(result: ActionResult<{ caseId: string }>, submittedCaseId: string): string {
  if (result.ok) return "/dashboard/cases?appeal=ok";
  const code = encodeURIComponent(result.error.code);
  return UUID.test(submittedCaseId) ? "/dashboard/cases/" + submittedCaseId + "/appeal?error=" + code : "/dashboard/cases?error=" + code;
}
