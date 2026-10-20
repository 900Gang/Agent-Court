import "server-only";
import { redirect } from "next/navigation";
import type { Operator } from "@/db/schema";
import { getOperator } from "@/lib/auth/session";

/** For dashboard sub-pages: signed in and active, otherwise back to sign-in or to the notice on /dashboard. */
export async function requireActiveOperator(): Promise<Operator> {
  const operator = await getOperator();
  if (!operator) redirect("/auth/login");
  if (operator.status !== "active") redirect("/dashboard");
  return operator;
}
