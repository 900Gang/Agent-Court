import { and, count, desc, eq, gt, isNull, or } from "drizzle-orm";
import { agents, apiKeys, operators, type Operator } from "@/db/schema";
import type { Database } from "@/db/types";
import { generateApiKey } from "@/lib/auth/apiKey";
import { MAX_ACTIVE_KEYS_PER_AGENT } from "@/lib/config/constants";
import { parseIssueKeyInput } from "@/lib/schemas/apiKey";
import { writeAudit } from "./auditService";
import { fail, ok, type ServiceResult } from "./result";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

/** What the dashboard may show about a key. The hash is deliberately not part of it. */
export type KeyListItem = Omit<typeof apiKeys.$inferSelect, "keyHash">;

// An explicit column list: the hash can never leak into a list because it is never selected.
const listColumns = {
  id: apiKeys.id,
  agentId: apiKeys.agentId,
  keyPrefix: apiKeys.keyPrefix,
  label: apiKeys.label,
  scopes: apiKeys.scopes,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
  revokedAt: apiKeys.revokedAt,
  createdAt: apiKeys.createdAt,
};

type IssueKeyResult = ServiceResult<
  { key: string; record: KeyListItem },
  "invalid" | "operator_not_active" | "agent_not_found" | "agent_not_active" | "key_limit"
>;
type RevokeKeyResult = ServiceResult<KeyListItem, "operator_not_active" | "key_not_found">;

export function isKeyActive(key: { revokedAt: Date | null; expiresAt: Date | null }, now: Date): boolean {
  if (key.revokedAt !== null) return false;
  return key.expiresAt === null || key.expiresAt.getTime() > now.getTime();
}

async function operatorIsActive(db: Database, operatorId: string): Promise<boolean> {
  const [current] = await db
    .select({ status: operators.status, deletedAt: operators.deletedAt })
    .from(operators)
    .where(eq(operators.id, operatorId))
    .limit(1);
  return current !== undefined && current.status === "active" && current.deletedAt === null;
}

/**
 * Issues a key. The raw key is returned here once and is not stored anywhere: the database
 * keeps only its hash, and the audit row holds the agent, scopes, expiry and label.
 * The agent row is locked so simultaneous requests cannot exceed the active-key cap.
 */
export async function issueKey(
  db: Database,
  operator: Operator,
  agentId: string,
  raw: unknown,
  now: Date = new Date(),
): Promise<IssueKeyResult> {
  const parsed = parseIssueKeyInput(raw);
  if (!parsed.ok) return parsed;
  const input = parsed.value;

  return db.transaction(async (tx): Promise<IssueKeyResult> => {
    if (!(await operatorIsActive(tx, operator.id))) return fail("operator_not_active");
    if (!UUID.test(agentId)) return fail("agent_not_found");

    const [agent] = await tx
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.operatorId, operator.id), isNull(agents.deletedAt)))
      .limit(1)
      .for("update");
    if (!agent) return fail("agent_not_found");
    if (agent.status !== "active") return fail("agent_not_active");

    const [{ total }] = await tx
      .select({ total: count() })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.agentId, agent.id),
          isNull(apiKeys.revokedAt),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
        ),
      );
    if (total >= MAX_ACTIVE_KEYS_PER_AGENT) return fail("key_limit");

    const generated = generateApiKey();
    const expiresAt =
      input.expiresInDays === null ? null : new Date(now.getTime() + input.expiresInDays * DAY_MS);
    const [record] = await tx
      .insert(apiKeys)
      .values({
        agentId: agent.id,
        keyHash: generated.hash,
        keyPrefix: generated.prefix,
        scopes: input.scopes,
        label: input.label,
        expiresAt,
      })
      .returning(listColumns);

    await writeAudit(tx, {
      actorOperatorId: operator.id,
      action: "key.issued",
      target: record.id,
      metadata: {
        agentId: agent.id,
        scopes: input.scopes,
        expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
        label: input.label,
      },
    });
    return ok({ key: generated.key, record });
  });
}

/** The keys of one of the operator's agents, newest first. Revoked and expired keys are included. */
export async function listKeys(db: Database, operatorId: string, agentId: string): Promise<KeyListItem[]> {
  if (!UUID.test(agentId)) return [];
  return db
    .select(listColumns)
    .from(apiKeys)
    .innerJoin(agents, eq(agents.id, apiKeys.agentId))
    .where(and(eq(apiKeys.agentId, agentId), eq(agents.operatorId, operatorId)))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
}

/**
 * Revokes a key. Repeating it keeps the original revocation time and writes no second audit row.
 * Works for keys of suspended or deleted agents, so cleanup is always possible.
 */
export async function revokeKey(
  db: Database,
  operator: Operator,
  keyId: string,
  now: Date = new Date(),
): Promise<RevokeKeyResult> {
  return db.transaction(async (tx): Promise<RevokeKeyResult> => {
    if (!(await operatorIsActive(tx, operator.id))) return fail("operator_not_active");
    if (!UUID.test(keyId)) return fail("key_not_found");

    const [existing] = await tx
      .select(listColumns)
      .from(apiKeys)
      .innerJoin(agents, eq(agents.id, apiKeys.agentId))
      .where(and(eq(apiKeys.id, keyId), eq(agents.operatorId, operator.id)))
      .limit(1)
      .for("update", { of: apiKeys });
    if (!existing) return fail("key_not_found");
    if (existing.revokedAt !== null) return ok(existing);

    const [revoked] = await tx
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(eq(apiKeys.id, keyId))
      .returning(listColumns);
    await writeAudit(tx, {
      actorOperatorId: operator.id,
      action: "key.revoked",
      target: keyId,
      metadata: { agentId: existing.agentId },
    });
    return ok(revoked);
  });
}
