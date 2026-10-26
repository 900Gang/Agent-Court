import type { Database } from "@/db/types";
import { isActiveAdmin } from "@/lib/auth/isActiveAdmin";
import type { ActionDeps, ActionResult } from "@/lib/dashboard/actionsCore";
import { describeError } from "@/lib/dashboard/messages";
import { assertSameOrigin } from "@/lib/http/origin";
import { publishHeldArgument, rejectHeldArgument } from "@/lib/services/argumentService";
import { writeAudit } from "@/lib/services/auditService";
import { publishHeldCase, publishHeldEvidence, rejectHeldCase, rejectHeldEvidence } from "@/lib/services/caseService";
import { recordModeration } from "@/lib/services/moderationService";
import { fail, ok, type ServiceResult } from "@/lib/services/result";

const KINDS = ["case", "evidence", "argument"] as const;
const DECISIONS = ["approve", "reject"] as const;
type Kind = (typeof KINDS)[number];
type Decision = (typeof DECISIONS)[number];

/** Fields come straight from a form, so they are plain strings here and checked below. */
export type ModerateInput = { kind: string; id: string; decision: string };

const failure = (code: string): ActionResult<never> => ({ ok: false, error: describeError(code) });

const isKind = (value: string): value is Kind => (KINDS as readonly string[]).includes(value);
const isDecision = (value: string): value is Decision => (DECISIONS as readonly string[]).includes(value);

async function decide(
  db: Database,
  kind: Kind,
  id: string,
  decision: Decision,
): Promise<ServiceResult<{ status: string }, "not_found" | "illegal_transition">> {
  const approve = decision === "approve";
  const result =
    kind === "case"
      ? await (approve ? publishHeldCase(db, id) : rejectHeldCase(db, id))
      : kind === "evidence"
        ? await (approve ? publishHeldEvidence(db, id) : rejectHeldEvidence(db, id))
        : await (approve ? publishHeldArgument(db, id) : rejectHeldArgument(db, id));
  return result.ok ? ok({ status: result.value.status }) : fail(result.error);
}

/**
 * An admin's decision on one held item. Order: same-origin check, then the admin check (anyone else gets the
 * answer a missing sign-in gets, so nothing is revealed), then the input, then the change together with its
 * audit row and its manual moderation event in one transaction.
 */
export async function moderateCore(deps: ActionDeps, input: ModerateInput): Promise<ActionResult<{ status: string }>> {
  try {
    assertSameOrigin(deps.headers, deps.expectedOrigin);
  } catch {
    return failure("origin_mismatch");
  }
  const operator = deps.operator;
  if (!isActiveAdmin(operator)) return failure("not_signed_in");
  if (!isKind(input.kind) || !isDecision(input.decision)) return failure("invalid");
  const { kind, decision } = input;

  return deps.db.transaction(async (tx): Promise<ActionResult<{ status: string }>> => {
    const result = await decide(tx, kind, input.id, decision);
    if (!result.ok) return failure(result.error);

    await writeAudit(tx, {
      actorType: "operator",
      actorId: operator.id,
      action: decision === "approve" ? "moderation.approved" : "moderation.rejected",
      target: input.id,
      metadata: { kind },
    });
    await recordModeration(tx, {
      targetType: kind,
      targetId: input.id,
      check: "manual",
      result: decision === "approve" ? "pass" : "block",
      details: { action: decision },
    });
    return { ok: true, value: { status: result.value.status } };
  });
}
