import { isActiveAdmin } from "@/lib/auth/isActiveAdmin";
import type { ActionDeps, ActionResult } from "@/lib/dashboard/actionsCore";
import { describeError } from "@/lib/dashboard/messages";
import { assertSameOrigin } from "@/lib/http/origin";
import { decideReview, handleReport } from "@/lib/services/reviewService";

const failure = (code: string): ActionResult<never> => ({ ok: false, error: describeError(code) });

/**
 * An administrator's decision on one report. Order: same-origin check, then the admin check (anyone else gets the answer
 * a missing sign-in gets, so nothing is revealed), then the service, which checks the admin again against the database.
 * Every refusal is a fixed message and writes nothing.
 */
export async function handleReportCore(deps: ActionDeps, input: { reportId: string; decision: string }): Promise<ActionResult<{ status: string }>> {
  try {
    assertSameOrigin(deps.headers, deps.expectedOrigin);
  } catch {
    return failure("origin_mismatch");
  }
  const operator = deps.operator;
  if (!isActiveAdmin(operator)) return failure("not_signed_in");

  const result = await handleReport(deps.db, operator, input);
  if (!result.ok) {
    const code =
      result.error === "forbidden"
        ? "not_signed_in"
        : result.error === "not_found"
          ? "report_not_found"
          : result.error === "report_closed"
            ? "report_not_open"
            : result.error === "illegal_transition"
              ? "review_not_possible"
              : result.error;
    return failure(code);
  }
  return { ok: true, value: { status: result.value.status } };
}

/**
 * An administrator upholds or overturns a verdict under review. Order: same-origin check, then the admin check (anyone
 * else gets the answer a missing sign-in gets), then the service, which checks the admin again against the database.
 * Every refusal is a fixed message and writes nothing.
 */
export async function decideReviewCore(deps: ActionDeps, input: { caseId: string; decision: string }): Promise<ActionResult<{ outcome: string }>> {
  try {
    assertSameOrigin(deps.headers, deps.expectedOrigin);
  } catch {
    return failure("origin_mismatch");
  }
  const operator = deps.operator;
  if (!isActiveAdmin(operator)) return failure("not_signed_in");

  const result = await decideReview(deps.db, operator, input, deps.now);
  if (!result.ok) {
    const code =
      result.error === "forbidden"
        ? "not_signed_in"
        : result.error === "not_found"
          ? "review_not_found"
          : result.error === "illegal_transition"
            ? "review_not_open"
            : result.error;
    return failure(code);
  }
  return { ok: true, value: { outcome: result.value.outcome } };
}
