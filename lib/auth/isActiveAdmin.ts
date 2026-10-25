import type { Operator } from "@/db/schema";

/**
 * True only for an admin whose account is active and not deleted. A pure check with no server imports, so the
 * admin actions can use it with a plain database and tests can call it directly.
 */
export function isActiveAdmin(operator: Operator | null): operator is Operator {
  return operator !== null && operator.role === "admin" && operator.status === "active" && operator.deletedAt === null;
}
