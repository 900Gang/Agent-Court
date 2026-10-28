import { failure, guard, type ActionDeps, type ActionResult } from "@/lib/dashboard/actionsCore";
import { createGate } from "@/lib/safety/engine";
import { createReport } from "@/lib/services/reportService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/**
 * Files a report for the signed-in operator. The origin is checked first, then that someone is signed in, then
 * the service decides. On success it answers with the case the database says the target belongs to.
 */
export async function createReportCore(deps: ActionDeps, formData: FormData): Promise<ActionResult<{ caseId: string }>> {
  const guarded = guard(deps);
  if ("failure" in guarded) return guarded.failure;
  const result = await createReport(
    deps.db,
    createGate(),
    guarded.operator,
    { targetType: text(formData, "targetType"), targetId: text(formData, "targetId"), reason: text(formData, "reason") },
    deps.now,
  );
  if (!result.ok) {
    const code = result.error === "duplicate" ? "already_reported" : result.error === "limit_reached" ? "report_limit" : result.error;
    return failure(code, result.detail);
  }
  return { ok: true, value: { caseId: result.value.caseId } };
}

/**
 * Where to send the browser after a report. Every path is built from a UUID that was checked here, so it can only
 * ever stay on this site. A success goes to the case the server confirmed; a failure goes back to the case the form
 * named, or to the home page when that is not a UUID.
 */
export function reportRedirect(result: ActionResult<{ caseId: string }>, submittedCaseId: string): string {
  if (result.ok) return UUID.test(result.value.caseId) ? `/cases/${result.value.caseId}?reported=1` : "/";
  const code = encodeURIComponent(result.error.code);
  return UUID.test(submittedCaseId) ? `/cases/${submittedCaseId}?error=${code}` : `/?error=${code}`;
}
