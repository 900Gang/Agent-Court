"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moderateCore } from "@/lib/admin/actionsCore";
import { addInviteCore, removeInviteCore } from "@/lib/admin/inviteCore";
import { setAgentStatusCore, setKillSwitchCore } from "@/lib/admin/killSwitchCore";
import { redactCore } from "@/lib/admin/redactCore";
import { decideReviewCore, handleReportCore } from "@/lib/admin/reviewCore";
import { buildActionDeps } from "@/lib/dashboard/context";
import { invalidateKillSwitch } from "@/lib/http/killSwitchRuntime";

const field = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

// A plain form post, like the dashboard's row actions: on failure it comes back with ?error=<code>,
// and the page looks the code up in a fixed table.
export async function moderateFormAction(formData: FormData): Promise<void> {
  const result = await moderateCore(await buildActionDeps(), {
    kind: field(formData, "kind"),
    id: field(formData, "id"),
    decision: field(formData, "decision"),
  });
  revalidatePath("/admin/moderation");
  redirect(result.ok ? "/admin/moderation" : `/admin/moderation?error=${encodeURIComponent(result.error.code)}`);
}

// Plain form post, like the moderation action: on failure it comes back with ?error=<code>.
export async function reportFormAction(formData: FormData): Promise<void> {
  const result = await handleReportCore(await buildActionDeps(), { reportId: field(formData, "reportId"), decision: field(formData, "decision") });
  revalidatePath("/admin/reports");
  revalidatePath("/admin/appeals");
  redirect(result.ok ? "/admin/reports" : `/admin/reports?error=${encodeURIComponent(result.error.code)}`);
}

// Plain form post: on failure it comes back with ?error=<code>.
export async function decideReviewFormAction(formData: FormData): Promise<void> {
  const result = await decideReviewCore(await buildActionDeps(), { caseId: field(formData, "caseId"), decision: field(formData, "decision") });
  revalidatePath("/admin/appeals");
  redirect(result.ok ? "/admin/appeals" : `/admin/appeals?error=${encodeURIComponent(result.error.code)}`);
}

// Plain form post: on success it comes back with ?done=<characters removed>, on failure with ?error=<code>.
export async function redactFormAction(formData: FormData): Promise<void> {
  const result = await redactCore(await buildActionDeps(), {
    targetType: field(formData, "targetType"),
    targetId: field(formData, "targetId"),
    field: field(formData, "field"),
    fragment: field(formData, "fragment"),
    blank: field(formData, "blank"),
  });
  revalidatePath("/admin/redact");
  redirect(result.ok ? `/admin/redact?done=${result.value.removed}` : `/admin/redact?error=${encodeURIComponent(result.error.code)}`);
}

// Plain form post: on failure it comes back with ?error=<code>. This process reads the flag again at once; the others
// catch up within the cache time (a few seconds).
export async function killSwitchFormAction(formData: FormData): Promise<void> {
  const result = await setKillSwitchCore(await buildActionDeps(), { value: field(formData, "value"), reason: field(formData, "reason") });
  if (result.ok) invalidateKillSwitch();
  revalidatePath("/admin/kill-switch");
  redirect(result.ok ? "/admin/kill-switch" : `/admin/kill-switch?error=${encodeURIComponent(result.error.code)}`);
}

// Plain form post, like the others.
export async function agentStatusFormAction(formData: FormData): Promise<void> {
  const result = await setAgentStatusCore(await buildActionDeps(), {
    agentId: field(formData, "agentId"),
    status: field(formData, "status"),
    reason: field(formData, "reason"),
  });
  revalidatePath("/admin/kill-switch");
  redirect(result.ok ? "/admin/kill-switch" : `/admin/kill-switch?error=${encodeURIComponent(result.error.code)}`);
}

// Plain form post: on success it comes back with ?added=<GitHub id> or ?exists=<GitHub id>, on failure with ?error=<code>.
export async function addInviteFormAction(formData: FormData): Promise<void> {
  const result = await addInviteCore(await buildActionDeps(), { login: field(formData, "login") });
  revalidatePath("/admin/invites");
  if (!result.ok) redirect(`/admin/invites?error=${encodeURIComponent(result.error.code)}`);
  redirect(`/admin/invites?${result.value.added ? "added" : "exists"}=${encodeURIComponent(result.value.githubId)}`);
}

// Plain form post: on success it comes back with ?removed=1, on failure with ?error=<code>.
export async function removeInviteFormAction(formData: FormData): Promise<void> {
  const result = await removeInviteCore(await buildActionDeps(), { githubId: field(formData, "githubId") });
  revalidatePath("/admin/invites");
  redirect(result.ok ? "/admin/invites?removed=1" : `/admin/invites?error=${encodeURIComponent(result.error.code)}`);
}
