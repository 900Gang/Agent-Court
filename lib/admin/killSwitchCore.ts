import { isActiveAdmin } from "@/lib/auth/isActiveAdmin";
import type { ActionDeps, ActionResult } from "@/lib/dashboard/actionsCore";
import { describeError } from "@/lib/dashboard/messages";
import { assertSameOrigin } from "@/lib/http/origin";
import { setAgentStatusAsAdmin } from "@/lib/services/agentService";
import { setKillSwitch } from "@/lib/services/killSwitchService";

const failure = (code: string): ActionResult<never> => ({ ok: false, error: describeError(code) });

/** What the kill switch form sends: `value` is "on" or "off". */
export type KillSwitchInput = { value: string; reason: string };
/** What an agent's form sends: the status it should have, "active" or "suspended". */
export type AgentStatusInput = { agentId: string; status: string; reason: string };

/**
 * An administrator turns the global kill switch on or off. Order, as for every admin action: same-origin check, then the
 * admin check (anyone else gets the answer a missing sign-in gets, so nothing is revealed), then the input, then the
 * service, which checks the admin again against the database and writes the audit row.
 */
export async function setKillSwitchCore(deps: ActionDeps, input: KillSwitchInput): Promise<ActionResult<{ on: boolean }>> {
  try {
    assertSameOrigin(deps.headers, deps.expectedOrigin);
  } catch {
    return failure("origin_mismatch");
  }
  const operator = deps.operator;
  if (!isActiveAdmin(operator)) return failure("not_signed_in");
  if (input.value !== "on" && input.value !== "off") return failure("invalid");

  const result = await setKillSwitch(deps.db, operator, input.value === "on", input.reason);
  if (!result.ok) return failure(result.error === "forbidden" ? "not_signed_in" : result.error);
  return { ok: true, value: { on: result.value.on } };
}

/** An administrator suspends or reactivates any agent. Same order as above. */
export async function setAgentStatusCore(deps: ActionDeps, input: AgentStatusInput): Promise<ActionResult<{ status: string }>> {
  try {
    assertSameOrigin(deps.headers, deps.expectedOrigin);
  } catch {
    return failure("origin_mismatch");
  }
  const operator = deps.operator;
  if (!isActiveAdmin(operator)) return failure("not_signed_in");
  if (input.status !== "active" && input.status !== "suspended") return failure("invalid");

  const result = await setAgentStatusAsAdmin(deps.db, operator, input.agentId, input.status, input.reason);
  if (!result.ok) return failure(result.error === "forbidden" ? "not_signed_in" : result.error);
  return { ok: true, value: { status: result.value.status } };
}
