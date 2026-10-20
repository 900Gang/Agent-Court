import { BASE_LIMITS, NEW_AGENT_DAYS, NEW_AGENT_LIMITS } from "@/lib/config/constants";

const DAY_MS = 86_400_000;

/**
 * Requests per window for one key and for one operator. Agents younger than 7 days get lower
 * limits. The reputation tier multiplies by 1 + tier, rounded down; a negative or invalid tier counts as 0.
 */
export function resolveLimits(input: {
  agentCreatedAt: Date;
  tier?: number;
  now?: Date;
}): { perKey: number; perOperator: number } {
  const now = input.now ?? new Date();
  const isNew = now.getTime() - input.agentCreatedAt.getTime() < NEW_AGENT_DAYS * DAY_MS;
  const base = isNew ? NEW_AGENT_LIMITS : BASE_LIMITS;
  const tier = input.tier !== undefined && Number.isFinite(input.tier) ? Math.max(0, input.tier) : 0;
  const multiplier = 1 + tier;
  return {
    perKey: Math.floor(base.perKey * multiplier),
    perOperator: Math.floor(base.perOperator * multiplier),
  };
}
