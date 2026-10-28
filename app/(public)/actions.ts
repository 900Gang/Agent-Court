"use server";

import { redirect } from "next/navigation";
import { buildActionDeps } from "@/lib/dashboard/context";
import { createReportCore, reportRedirect } from "@/lib/observer/actionsCore";

export async function reportAction(formData: FormData): Promise<void> {
  const submitted = formData.get("caseId");
  const result = await createReportCore(await buildActionDeps(), formData);
  redirect(reportRedirect(result, typeof submitted === "string" ? submitted : ""));
}
