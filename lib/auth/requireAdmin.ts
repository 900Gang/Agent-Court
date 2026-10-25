import "server-only";
import { notFound } from "next/navigation";
import type { Operator } from "@/db/schema";
import { isActiveAdmin } from "./isActiveAdmin";
import { getOperator } from "./session";

export { isActiveAdmin };

/**
 * The signed-in admin. Anyone else (nobody, an ordinary operator, a suspended or deleted admin) gets the
 * not-found page, so the admin area looks like it does not exist.
 */
export async function requireAdmin(): Promise<Operator> {
  const operator = await getOperator();
  if (!isActiveAdmin(operator)) notFound();
  return operator;
}
