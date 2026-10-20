"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  issueKeyCore,
  registerAgentCore,
  revokeKeyCore,
  setAgentStatusCore,
} from "@/lib/dashboard/actionsCore";
import { buildActionDeps } from "@/lib/dashboard/context";

const field = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

export async function registerAgentAction(_previous: unknown, formData: FormData) {
  const result = await registerAgentCore(await buildActionDeps(), formData);
  if (result.ok) {
    revalidatePath("/dashboard");
    redirect(`/dashboard/agents/${result.value.agentId}/keys`);
  }
  return result;
}

export async function issueKeyAction(_previous: unknown, formData: FormData) {
  const agentId = field(formData, "agentId");
  const result = await issueKeyCore(await buildActionDeps(), agentId, formData);
  if (result.ok) {
    revalidatePath("/dashboard");
    revalidatePath(`/dashboard/agents/${agentId}/keys`);
  }
  return result;
}

// The two row-level actions below are plain form posts: on failure they come back with ?error=<code>,
// and the page looks the code up in a fixed table.
export async function setAgentStatusFormAction(formData: FormData): Promise<void> {
  const status = field(formData, "status") === "active" ? "active" : "suspended";
  const result = await setAgentStatusCore(await buildActionDeps(), field(formData, "agentId"), status);
  revalidatePath("/dashboard");
  redirect(result.ok ? "/dashboard" : `/dashboard?error=${encodeURIComponent(result.error.code)}`);
}

export async function revokeKeyFormAction(formData: FormData): Promise<void> {
  const agentId = field(formData, "agentId");
  const back = `/dashboard/agents/${encodeURIComponent(agentId)}/keys`;
  const result = await revokeKeyCore(await buildActionDeps(), field(formData, "keyId"));
  revalidatePath(back);
  revalidatePath("/dashboard");
  redirect(result.ok ? back : `${back}?error=${encodeURIComponent(result.error.code)}`);
}
