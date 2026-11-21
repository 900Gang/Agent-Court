import { isActiveAdmin } from "@/lib/auth/isActiveAdmin";
import type { ActionDeps, ActionResult } from "@/lib/dashboard/actionsCore";
import { describeError } from "@/lib/dashboard/messages";
import { createGithubLookup, type GithubLookup } from "@/lib/github/lookup";
import { assertSameOrigin } from "@/lib/http/origin";
import { addInvite, removeInvite } from "@/lib/services/inviteService";

const failure = (code: string): ActionResult<never> => ({ ok: false, error: describeError(code) });

/** The dependencies of an action, plus the lookup of a GitHub login. Tests pass a fake lookup; the real one is the default. */
export type InviteDeps = ActionDeps & { lookup?: GithubLookup };

/** What the invite form sends. A leading @ and surrounding spaces are removed; everything else is checked by the service. */
export type AddInviteInput = { login: string };
export type RemoveInviteInput = { githubId: string };

/**
 * An administrator invites a GitHub account. Order, as for every admin action: same-origin check, then the admin check
 * (anyone else gets the answer a missing sign-in gets), then the input, then the service, which checks the admin again,
 * asks GitHub once and writes the audit row.
 */
export async function addInviteCore(
  deps: InviteDeps,
  input: AddInviteInput,
): Promise<ActionResult<{ githubId: string; githubLogin: string; added: boolean }>> {
  try {
    assertSameOrigin(deps.headers, deps.expectedOrigin);
  } catch {
    return failure("origin_mismatch");
  }
  const operator = deps.operator;
  if (!isActiveAdmin(operator)) return failure("not_signed_in");
  const login = typeof input.login === "string" ? input.login.trim().replace(/^@/, "") : "";

  const result = await addInvite(deps.db, operator, login, deps.lookup ?? createGithubLookup());
  if (!result.ok) return failure(result.error === "forbidden" ? "not_signed_in" : result.error);
  return { ok: true, value: result.value };
}

/** An administrator removes an invite. Same order as above. */
export async function removeInviteCore(deps: InviteDeps, input: RemoveInviteInput): Promise<ActionResult<{ removed: boolean }>> {
  try {
    assertSameOrigin(deps.headers, deps.expectedOrigin);
  } catch {
    return failure("origin_mismatch");
  }
  const operator = deps.operator;
  if (!isActiveAdmin(operator)) return failure("not_signed_in");

  const result = await removeInvite(deps.db, operator, input.githubId);
  if (!result.ok) return failure(result.error === "forbidden" ? "not_signed_in" : result.error);
  return { ok: true, value: result.value };
}
