import { and, eq, isNull, lte, or } from "drizzle-orm";
import { agents, apiKeys, operators } from "@/db/schema";
import type { Database } from "@/db/types";
import { API_SCOPES, type ApiScope } from "@/lib/config/constants";
import { extractBearerKey, hashApiKey } from "./apiKey";

export type AuthContext = {
  keyId: string;
  agentId: string;
  operatorId: string;
  scopes: ApiScope[];
  agentCreatedAt: Date;
};

export type AuthFailure =
  | "missing_key"
  | "invalid_key"
  | "revoked_key"
  | "expired_key"
  | "agent_inactive"
  | "operator_inactive";

export type AuthResult = { ok: true; auth: AuthContext } | { ok: false; code: AuthFailure };

const LAST_USED_INTERVAL_MS = 60_000;

const isApiScope = (value: string): value is ApiScope => (API_SCOPES as readonly string[]).includes(value);

/**
 * Decides whether a request may proceed. Order of checks, so one request always gets one answer:
 * header, key exists, key revoked, key expired, agent standing, operator standing.
 * Standing is read live, so suspending an agent or operator takes effect on the next request.
 */
export async function authenticateApiKey(
  db: Database,
  authorizationHeader: string | null,
  now: Date = new Date(),
): Promise<AuthResult> {
  const key = extractBearerKey(authorizationHeader);
  if (key === null) return { ok: false, code: "missing_key" };

  const [row] = await db
    .select({
      keyId: apiKeys.id,
      scopes: apiKeys.scopes,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
      lastUsedAt: apiKeys.lastUsedAt,
      agentId: agents.id,
      agentStatus: agents.status,
      agentDeletedAt: agents.deletedAt,
      agentCreatedAt: agents.createdAt,
      operatorId: operators.id,
      operatorStatus: operators.status,
      operatorDeletedAt: operators.deletedAt,
    })
    .from(apiKeys)
    .innerJoin(agents, eq(agents.id, apiKeys.agentId))
    .innerJoin(operators, eq(operators.id, agents.operatorId))
    .where(eq(apiKeys.keyHash, hashApiKey(key)))
    .limit(1);

  if (!row) return { ok: false, code: "invalid_key" };
  if (row.revokedAt !== null) return { ok: false, code: "revoked_key" };
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, code: "expired_key" };
  }
  if (row.agentStatus !== "active" || row.agentDeletedAt !== null) {
    return { ok: false, code: "agent_inactive" };
  }
  if (row.operatorStatus !== "active" || row.operatorDeletedAt !== null) {
    return { ok: false, code: "operator_inactive" };
  }

  // At most one write per key per minute. The condition is part of the UPDATE, so
  // simultaneous requests cannot each decide to write.
  if (row.lastUsedAt === null || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_INTERVAL_MS) {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiKeys.id, row.keyId),
          or(isNull(apiKeys.lastUsedAt), lte(apiKeys.lastUsedAt, new Date(now.getTime() - LAST_USED_INTERVAL_MS))),
        ),
      );
  }

  return {
    ok: true,
    auth: {
      keyId: row.keyId,
      agentId: row.agentId,
      operatorId: row.operatorId,
      scopes: row.scopes.filter(isApiScope),
      agentCreatedAt: row.agentCreatedAt,
    },
  };
}

export function hasScope(auth: AuthContext, scope: ApiScope): boolean {
  return auth.scopes.includes(scope);
}
