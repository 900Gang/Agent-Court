import { isActiveAdmin } from "@/lib/auth/isActiveAdmin";
import { EMBEDDING } from "@/lib/config/constants";
import type { ActionDeps, ActionResult } from "@/lib/dashboard/actionsCore";
import { describeError } from "@/lib/dashboard/messages";
import { assertSameOrigin } from "@/lib/http/origin";
import { embedCase } from "@/lib/services/embeddingService";
import { applyRedaction } from "@/lib/services/redactionService";

const failure = (code: string): ActionResult<never> => ({ ok: false, error: describeError(code) });

/** What the redact form sends. `blank` is the checkbox: "on" when ticked, otherwise empty. */
export type RedactInput = { targetType: string; targetId: string; field: string; fragment: string; blank: string };

/**
 * An administrator removes text. Order: same-origin check, then the admin check (anyone else gets the answer a missing
 * sign-in gets), then the form's two ways of asking (a fragment, or the box ticked with no fragment, never both and
 * never neither), then the service. Afterwards the case is embedded again, outside the transaction: a failure changes
 * nothing, and the re-embed job catches up. The answer holds only the number of characters removed.
 */
export async function redactCore(deps: ActionDeps, input: RedactInput): Promise<ActionResult<{ removed: number }>> {
  try {
    assertSameOrigin(deps.headers, deps.expectedOrigin);
  } catch {
    return failure("origin_mismatch");
  }
  const operator = deps.operator;
  if (!isActiveAdmin(operator)) return failure("not_signed_in");

  const blank = input.blank === "on";
  if (blank === (input.fragment !== "")) return failure("invalid");

  const result = await applyRedaction(
    deps.db,
    operator,
    { targetType: input.targetType, targetId: input.targetId, field: input.field, fragment: blank ? null : input.fragment },
    deps.now,
  );
  if (!result.ok) {
    const code =
      result.error === "forbidden" ? "not_signed_in" : result.error === "not_found" ? "redact_target_not_found" : result.error;
    return failure(code);
  }

  if (deps.embedder) {
    try {
      await embedCase(deps.db, deps.embedder, result.value.caseId, { timeoutMs: EMBEDDING.requestTimeoutMs });
    } catch {
      // The redaction stands. The re-embed job picks the case up.
    }
  }
  return { ok: true, value: { removed: result.value.removed } };
}
