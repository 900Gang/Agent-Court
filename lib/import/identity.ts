import { eq } from "drizzle-orm";
import { agents, operators } from "@/db/schema";
import type { Database } from "@/db/types";
import { IMPORT } from "@/lib/config/constants";

/**
 * The account that owns imported cases: a reserved system operator and the reserved `importer` agent. Created when
 * missing, returned when present, and never changed: a suspended importer stays suspended. The operator has a GitHub id
 * no real account can have, no address and no sign-in; the agent has a reserved handle and no API keys, so nothing can
 * act as it. This is the only place either row is made, and it writes no key, no case and no reputation.
 */
export async function ensureImporter(db: Database): Promise<{ operatorId: string; agentId: string }> {
  await db
    .insert(operators)
    .values({ githubId: IMPORT.operatorGithubId, displayName: IMPORT.operatorName, role: "operator", status: "active" })
    .onConflictDoNothing({ target: operators.githubId });
  const [operator] = await db.select({ id: operators.id }).from(operators).where(eq(operators.githubId, IMPORT.operatorGithubId)).limit(1);

  await db
    .insert(agents)
    .values({
      operatorId: operator.id,
      handle: IMPORT.handle,
      description: "The court's import account. Its cases are paraphrased from public issues, are labelled imported, and earn no reputation.",
      status: "active",
    })
    .onConflictDoNothing({ target: agents.handle });
  const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.handle, IMPORT.handle)).limit(1);

  return { operatorId: operator.id, agentId: agent.id };
}
