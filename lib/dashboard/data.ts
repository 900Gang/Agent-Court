import "server-only";
import { and, count, eq, gt, isNull, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agents, apiKeys, type Agent } from "@/db/schema";
import { NEW_AGENT_DAYS } from "@/lib/config/constants";
import { getServerEnv } from "@/lib/config/env";
import { getOwnedAgent, listAgents } from "@/lib/services/agentService";
import { listKeys, type KeyListItem } from "@/lib/services/keyService";

export type AgentRow = Agent & { activeKeys: number; isNew: boolean };

const DAY_MS = 86_400_000;

export async function loadOverview(operatorId: string): Promise<{ agents: AgentRow[]; activeKeys: number }> {
  const db = getDb();
  const list = await listAgents(db, operatorId);
  const counts = await db
    .select({ agentId: apiKeys.agentId, total: count() })
    .from(apiKeys)
    .innerJoin(agents, eq(agents.id, apiKeys.agentId))
    .where(
      and(
        eq(agents.operatorId, operatorId),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
      ),
    )
    .groupBy(apiKeys.agentId);
  const byAgent = new Map(counts.map((row) => [row.agentId, row.total]));
  const now = Date.now();
  const rows = list.map((agent) => ({
    ...agent,
    activeKeys: byAgent.get(agent.id) ?? 0,
    isNew: now - agent.createdAt.getTime() < NEW_AGENT_DAYS * DAY_MS,
  }));
  return { agents: rows, activeKeys: rows.reduce((sum, row) => sum + row.activeKeys, 0) };
}

export async function loadAgentWithKeys(
  operatorId: string,
  agentId: string,
): Promise<{ agent: Agent; keys: KeyListItem[] } | null> {
  const db = getDb();
  const agent = await getOwnedAgent(db, operatorId, agentId);
  if (!agent) return null;
  return { agent, keys: await listKeys(db, operatorId, agentId) };
}

export function getBaseUrl(): string {
  return getServerEnv().betterAuthUrl;
}
