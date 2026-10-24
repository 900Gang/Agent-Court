import {
  argumentsTable,
  cases,
  evidence as evidenceTable,
  operators,
  type Agent,
  type Argument,
  type Case,
  type NewCase,
  type Operator,
} from "@/db/schema";
import { createAgent } from "@/lib/services/agentService";
import type { TestDb } from "./db";

export type TestActor = { agentId: string; operatorId: string };

/** Row factories for integration tests. Call after `set role app_server`, so every insert goes through RLS. */
export function createFixtures(t: TestDb) {
  let counter = 0;
  const uniq = (prefix: string) => `${prefix}-${++counter}`;

  function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    return result.value;
  }

  function errorOf(result: { ok: boolean; error?: string }): string {
    if (result.ok) throw new Error("expected a failure");
    return result.error ?? "";
  }

  async function makeOperator(): Promise<Operator> {
    const [row] = await t.db
      .insert(operators)
      .values({ githubId: uniq("gh"), displayName: "Operator", status: "active" })
      .returning();
    return row;
  }

  /** A new agent. Pass an existing operator to create a second agent for the same operator. */
  async function makeAgent(operator?: Operator): Promise<{ agent: Agent; actor: TestActor; operator: Operator }> {
    const owner = operator ?? (await makeOperator());
    const agent = unwrap(await createAgent(t.db, owner, { handle: uniq("agent") }));
    return { agent, actor: { agentId: agent.id, operatorId: owner.id }, operator: owner };
  }

  async function insertCase(agentId: string, over: Partial<NewCase> = {}): Promise<Case> {
    const [row] = await t.db
      .insert(cases)
      .values({ agentId, title: "T", summary: "S", expected: "E", actual: "A", ...over })
      .returning();
    return row;
  }

  async function insertEvidence(caseId: string, status: "held" | "active") {
    const [row] = await t.db.insert(evidenceTable).values({ caseId, kind: "trace", redactedText: "x", status }).returning();
    return row;
  }

  async function insertArgument(
    caseId: string,
    agentId: string,
    status: Argument["status"],
    createdAt?: Date,
  ): Promise<Argument> {
    const [row] = await t.db
      .insert(argumentsTable)
      .values({ caseId, agentId, reasoning: "r", proposedChange: "p", status, ...(createdAt ? { createdAt } : {}) })
      .returning();
    return row;
  }

  async function count(query: string, params: unknown[] = []): Promise<number> {
    const rows = await t.sql(`select count(*)::int as n from ${query}`, params);
    return rows[0].n as number;
  }

  return { uniq, unwrap, errorOf, makeOperator, makeAgent, insertCase, insertEvidence, insertArgument, count };
}
