import { and, count, desc, eq, isNull } from "drizzle-orm";
import { agents, operators, type Agent, type Operator } from "@/db/schema";
import type { Database } from "@/db/types";
import { MAX_AGENTS_PER_OPERATOR } from "@/lib/config/constants";
import { parseAgentInput } from "@/lib/schemas/agent";
import { writeAudit } from "./auditService";
import { fail, ok, type ServiceResult } from "./result";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CreateAgentResult = ServiceResult<
  Agent,
  "invalid" | "operator_not_active" | "agent_limit" | "handle_taken"
>;

type SetStatusResult = ServiceResult<Agent, "operator_not_active" | "agent_not_found">;

// Drizzle wraps driver errors, so the SQLSTATE code may be on `cause`.
function errorCode(error: unknown): string | undefined {
  const direct = (error as { code?: unknown }).code;
  const nested = (error as { cause?: { code?: unknown } }).cause?.code;
  const code = direct ?? nested;
  return typeof code === "string" ? code : undefined;
}

/**
 * Registers an agent. The operator's current status comes from the database, not from the
 * object passed in, and the operator row is locked so simultaneous requests cannot exceed the cap.
 */
export async function createAgent(
  db: Database,
  operator: Operator,
  raw: unknown,
): Promise<CreateAgentResult> {
  const parsed = parseAgentInput(raw);
  if (!parsed.ok) return parsed;
  const input = parsed.value;

  try {
    return await db.transaction(async (tx): Promise<CreateAgentResult> => {
      const [current] = await tx
        .select({ status: operators.status, deletedAt: operators.deletedAt })
        .from(operators)
        .where(eq(operators.id, operator.id))
        .limit(1)
        .for("update");
      if (!current || current.status !== "active" || current.deletedAt !== null) {
        return fail("operator_not_active");
      }

      const [{ total }] = await tx
        .select({ total: count() })
        .from(agents)
        .where(and(eq(agents.operatorId, operator.id), isNull(agents.deletedAt)));
      if (total >= MAX_AGENTS_PER_OPERATOR) return fail("agent_limit");

      const [taken] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.handle, input.handle))
        .limit(1);
      if (taken) return fail("handle_taken");

      const [agent] = await tx
        .insert(agents)
        .values({
          operatorId: operator.id,
          handle: input.handle,
          model: input.model,
          framework: input.framework,
          description: input.description,
        })
        .returning();
      await writeAudit(tx, {
        actorType: "operator",
        actorId: operator.id,
        action: "agent.created",
        target: agent.id,
        metadata: { handle: agent.handle },
      });
      return ok(agent);
    });
  } catch (error) {
    // Backstop: the unique index on handle caught a race the read above could not.
    if (errorCode(error) === "23505") return fail("handle_taken");
    throw error;
  }
}

/** The operator's own, non-deleted agents, newest first (suspended ones included). */
export async function listAgents(db: Database, operatorId: string): Promise<Agent[]> {
  return db
    .select()
    .from(agents)
    .where(and(eq(agents.operatorId, operatorId), isNull(agents.deletedAt)))
    .orderBy(desc(agents.createdAt), desc(agents.id));
}

export async function getOwnedAgent(
  db: Database,
  operatorId: string,
  agentId: string,
): Promise<Agent | null> {
  if (!UUID.test(agentId)) return null;
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.operatorId, operatorId), isNull(agents.deletedAt)))
    .limit(1);
  return agent ?? null;
}

/** Suspends or reactivates one of the operator's agents. Repeating a change writes no second audit row. */
export async function setAgentStatus(
  db: Database,
  operator: Operator,
  agentId: string,
  status: "active" | "suspended",
): Promise<SetStatusResult> {
  return db.transaction(async (tx): Promise<SetStatusResult> => {
    const [current] = await tx
      .select({ status: operators.status, deletedAt: operators.deletedAt })
      .from(operators)
      .where(eq(operators.id, operator.id))
      .limit(1);
    if (!current || current.status !== "active" || current.deletedAt !== null) {
      return fail("operator_not_active");
    }
    if (!UUID.test(agentId)) return fail("agent_not_found");

    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.operatorId, operator.id), isNull(agents.deletedAt)))
      .limit(1)
      .for("update");
    if (!agent) return fail("agent_not_found");
    if (agent.status === status) return ok(agent);

    const [updated] = await tx
      .update(agents)
      .set({ status })
      .where(eq(agents.id, agent.id))
      .returning();
    await writeAudit(tx, {
      actorType: "operator",
      actorId: operator.id,
      action: status === "suspended" ? "agent.suspended" : "agent.reactivated",
      target: agent.id,
      metadata: { handle: agent.handle },
    });
    return ok(updated);
  });
}

/** A non-deleted agent by its exact handle (handles are stored in lower case). */
export async function getAgentByHandle(db: Database, handle: string): Promise<Agent | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.handle, handle), isNull(agents.deletedAt)))
    .limit(1);
  return agent ?? null;
}
