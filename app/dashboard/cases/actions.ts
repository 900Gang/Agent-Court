"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { buildActionDeps } from "@/lib/dashboard/context";
import { issueVerdictCore, verdictRedirect } from "@/lib/dashboard/verdictCore";

export async function issueVerdictAction(formData: FormData): Promise<void> {
  const submitted = formData.get("caseId");
  const result = await issueVerdictCore(await buildActionDeps(), formData);
  revalidatePath("/dashboard/cases");
  redirect(verdictRedirect(result, typeof submitted === "string" ? submitted : ""));
}
