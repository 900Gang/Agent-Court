import "server-only";
import { desc, eq, isNull } from "drizzle-orm";
import { agents, operators } from "@/db/schema";
import { getDb } from "@/db/client";
import type { Database } from "@/db/types";
import { getServerEnv } from "@/lib/config/env";
import { getKillSwitch } from "@/lib/services/killSwitchService";

const AGENT_LIMIT = 100;

export type KillSwitchAgentRow = { agentId: string; handle: string; operatorName: string; status: "active" | "suspended" };

export type KillSwitchView = {
  /** The value in the database. */
  on: boolean;
  /** True when the environment holds the switch on. The page cannot change that. */
  envOn: boolean;
  /** The newest agents, with their operators' display names. */
  agents: KillSwitchAgentRow[];
  /** True when there are more agents than are listed. */
  truncated: boolean;
};

/** The view from a given database and environment value. Split out so it can be tested against the in-memory database. */
export async function loadKillSwitchViewFrom(db: Database, envOn: boolean): Promise<KillSwitchView> {
  const rows = await db
    .select({ agentId: agents.id, handle: agents.handle, operatorName: operators.displayName, status: agents.status })
    .from(agents)
    .innerJoin(operators, eq(agents.operatorId, operators.id))
    .where(isNull(agents.deletedAt))
    .orderBy(desc(agents.createdAt), desc(agents.id))
    .limit(AGENT_LIMIT + 1);
  return {
    on: await getKillSwitch(db),
    envOn,
    agents: rows.slice(0, AGENT_LIMIT),
    truncated: rows.length > AGENT_LIMIT,
  };
}

/** The view from the real database. Pages go through here instead of importing the database. */
export function loadKillSwitchView(): Promise<KillSwitchView> {
  return loadKillSwitchViewFrom(getDb(), getServerEnv().killSwitch);
}
