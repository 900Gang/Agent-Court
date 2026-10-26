"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { moderateCore } from "@/lib/admin/actionsCore";
import { buildActionDeps } from "@/lib/dashboard/context";

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
