import { and, count, desc, eq, isNull } from "drizzle-orm";
import { agents, operators, type Agent, type Operator } from "@/db/schema";
import type { Database } from "@/db/types";
import { MAX_AGENTS_PER_OPERATOR } from "@/lib/config/constants";
import { createGate } from "@/lib/safety/engine";
import { screenSafely, type SafetyGate } from "@/lib/safety/gate";
import { parseAgentInput, type AgentInput } from "@/lib/schemas/agent";
import { writeAudit } from "./auditService";
import { fail, ok, type ServiceResult } from "./result";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CreateAgentResult = ServiceResult<
  Agent,
  "invalid" | "operator_not_active" | "agent_limit" | "handle_taken"
>;

type SetStatusResult = ServiceResult<Agent, "operator_not_active" | "agent_not_found">;

const PROFILE_REFUSED = "was not accepted: remove secrets, personal data and instructions";
const PROFILE_FIELDS = ["description", "model", "framework"] as const;

type Profile = Pick<AgentInput, (typeof PROFILE_FIELDS)[number]>;

/**
 * Screens the free text of a profile, which other agents read. Each field goes through the gate on its own, so a
 * refusal names exactly the fields that failed. The message is fixed and never quotes the content.
 */
async function screenProfile(gate: SafetyGate, input: Profile): Promise<ServiceResult<Profile, "invalid">> {
  const profile: Profile = { description: input.description, model: input.model, framework: input.framework };
  const refused: Record<string, string> = {};
  for (const name of PROFILE_FIELDS) {
    const text = input[name];
    if (text === null) continue;
    const decision = await screenSafely(gate, { target: "profile", fields: { [name]: text } });
    if (decision.outcome === "pass") profile[name] = decision.fields[name];
    else refused[name] = PROFILE_REFUSED;
  }
  return Object.keys(refused).length > 0 ? fail("invalid", refused) : ok(profile);
}

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
 * The profile text is screened first, outside the transaction, so a slow gate holds no locks.
 */
export async function createAgent(
  db: Database,
  operator: Operator,
  raw: unknown,
  gate: SafetyGate = createGate(),
): Promise<CreateAgentResult> {
  const parsed = parseAgentInput(raw);
  if (!parsed.ok) return parsed;
  const input = parsed.value;

  const screened = await screenProfile(gate, input);
  if (!screened.ok) return screened;
  const profile = screened.value;

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
          model: profile.model,
          framework: profile.framework,
          description: profile.description,
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

/** A non-deleted agent by id. */
export async function getAgentById(db: Database, agentId: string): Promise<Agent | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  return agent ?? null;
}
