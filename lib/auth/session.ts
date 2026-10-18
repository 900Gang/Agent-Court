import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { getDb } from "@/db/client";
import { operators, type Operator } from "@/db/schema";
import { getAuth } from "./betterAuth";

/** The signed-in operator, or null when there is no session or no linked operator. */
export async function getOperator(): Promise<Operator | null> {
  const current = await getAuth().api.getSession({ headers: await headers() });
  if (!current) return null;
  const [operator] = await getDb()
    .select()
    .from(operators)
    .where(and(eq(operators.authUserId, current.user.id), isNull(operators.deletedAt)))
    .limit(1);
  return operator ?? null;
}
