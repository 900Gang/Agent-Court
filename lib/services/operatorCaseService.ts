import { and, asc, count, desc, eq, inArray, isNull, min, ne } from "drizzle-orm";
import { agents, argumentsTable, cases, verdicts, type Case } from "@/db/schema";
import type { Database } from "@/db/types";
import { appealDeadline } from "@/lib/lifecycle/rules";
import { getReputationForAgents } from "./reputationService";

// What the operator's dashboard reads (N8a). Everything is scoped by the operator's id, which the caller takes from the
// signed-in session and never from a request. A case or an agent of another operator is simply not found.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASE_LIMIT = 50;

/** The most cases the list shows, newest first. */
export const getOperatorCasesLimit = (): number => CASE_LIMIT;

export type OperatorCaseRow = {
  id: string;
  title: string;
  status: Case["status"];
  agentHandle: string;
  createdAt: Date;
  /** Active arguments: the ones waiting for a verdict. */
  argumentCount: number;
  /** When the oldest active argument was made, or null when there is none. */
  oldestArgumentAt: Date | null;
  /** The verdict the case stands on (an overturned one is history and not shown), or null. */
  verdict: { status: "active" | "under_appeal"; createdAt: Date; appealed: boolean } | null;
};

export type OperatorAgentRow = { id: string; handle: string; points: number; pending: number; tier: 0 | 1 | 2 | 3 };

/**
 * The cases filed by this operator's agents, newest first and capped, and one row per agent with final points, pending
 * points and the tier. Three statements whatever the amount of data (two when the operator has no agent). Holds no
 * operator id.
 */
export async function listOperatorCases(
  db: Database,
  operatorId: string,
): Promise<{ cases: OperatorCaseRow[]; agents: OperatorAgentRow[] }> {
  if (!UUID.test(operatorId)) return { cases: [], agents: [] };

  const [caseRows, agentRows] = await Promise.all([
    db
      .select({
        id: cases.id,
        title: cases.title,
        status: cases.status,
        createdAt: cases.createdAt,
        agentHandle: agents.handle,
        argumentCount: count(argumentsTable.id),
        oldestArgumentAt: min(argumentsTable.createdAt),
        verdictId: verdicts.id,
        verdictStatus: verdicts.status,
        verdictCreatedAt: verdicts.createdAt,
        verdictAppealedAt: verdicts.appealedAt,
      })
      .from(cases)
      .innerJoin(agents, eq(agents.id, cases.agentId))
      .leftJoin(argumentsTable, and(eq(argumentsTable.caseId, cases.id), eq(argumentsTable.status, "active")))
      .leftJoin(verdicts, and(eq(verdicts.caseId, cases.id), ne(verdicts.status, "overturned")))
      .where(eq(agents.operatorId, operatorId))
      .groupBy(cases.id, agents.handle, verdicts.id)
      .orderBy(desc(cases.createdAt), desc(cases.id))
      .limit(CASE_LIMIT),
    db
      .select({ id: agents.id, handle: agents.handle })
      .from(agents)
      .where(and(eq(agents.operatorId, operatorId), isNull(agents.deletedAt)))
      .orderBy(asc(agents.createdAt), asc(agents.id)),
  ]);

  const reputation = await getReputationForAgents(db, agentRows.map((row) => row.id));
  return {
    cases: caseRows.map(({ verdictId, verdictStatus, verdictCreatedAt, verdictAppealedAt, ...row }) => ({
      ...row,
      verdict:
        verdictId === null || verdictStatus === null || verdictCreatedAt === null
          ? null
          : { status: verdictStatus as "active" | "under_appeal", createdAt: verdictCreatedAt, appealed: verdictAppealedAt !== null },
    })),
    agents: agentRows.map((row) => {
      const r = reputation.get(row.id) ?? { points: 0, pending: 0, tier: 0 as const };
      return { id: row.id, handle: row.handle, points: r.points, pending: r.pending, tier: r.tier };
    }),
  };
}

export type VerdictFormArgument = {
  id: string;
  authorHandle: string;
  reasoning: string;
  proposedChange: string;
  createdAt: Date;
};

export type VerdictFormView = { caseId: string; title: string; arguments: VerdictFormArgument[] };

/**
 * What the verdict form needs: the case and its active arguments, oldest first. Null for anything the operator may not
 * decide: not their case (the same as an unknown case), not open or argued, or no active argument. Two statements.
 */
export async function getVerdictFormView(db: Database, operatorId: string, caseId: string): Promise<VerdictFormView | null> {
  if (!UUID.test(operatorId) || !UUID.test(caseId)) return null;
  const [c] = await db
    .select({ id: cases.id, title: cases.title })
    .from(cases)
    .innerJoin(agents, eq(agents.id, cases.agentId))
    .where(and(eq(cases.id, caseId), eq(agents.operatorId, operatorId), inArray(cases.status, ["open", "argued"])))
    .limit(1);
  if (!c) return null;
  const rows = await db
    .select({
      id: argumentsTable.id,
      authorHandle: agents.handle,
      reasoning: argumentsTable.reasoning,
      proposedChange: argumentsTable.proposedChange,
      createdAt: argumentsTable.createdAt,
    })
    .from(argumentsTable)
    .innerJoin(agents, eq(agents.id, argumentsTable.agentId))
    .where(and(eq(argumentsTable.caseId, caseId), eq(argumentsTable.status, "active")))
    .orderBy(asc(argumentsTable.createdAt), asc(argumentsTable.id));
  if (rows.length === 0) return null;
  return { caseId: c.id, title: c.title, arguments: rows };
}

export type AppealFormView = { caseId: string; title: string; verdictAt: Date; deadline: Date };

/**
 * What the appeal form needs: the case title, when the verdict was issued and the deadline. Null for anything that cannot
 * be appealed now: not the operator's case (the same as an unknown case), no live verdict, a verdict that is not active
 * or was appealed already, or a deadline that has passed. One statement.
 */
export async function getAppealFormView(db: Database, operatorId: string, caseId: string, now: Date = new Date()): Promise<AppealFormView | null> {
  if (!UUID.test(operatorId) || !UUID.test(caseId)) return null;
  const [row] = await db
    .select({
      id: cases.id,
      title: cases.title,
      status: cases.status,
      verdictAt: verdicts.createdAt,
      verdictStatus: verdicts.status,
      appealedAt: verdicts.appealedAt,
    })
    .from(cases)
    .innerJoin(agents, eq(agents.id, cases.agentId))
    .innerJoin(verdicts, and(eq(verdicts.caseId, cases.id), ne(verdicts.status, "overturned")))
    .where(and(eq(cases.id, caseId), eq(agents.operatorId, operatorId)))
    .limit(1);
  if (!row || row.status !== "resolved" || row.verdictStatus !== "active" || row.appealedAt !== null) return null;
  const deadline = appealDeadline(row.verdictAt);
  if (now.getTime() > deadline.getTime()) return null;
  return { caseId: row.id, title: row.title, verdictAt: row.verdictAt, deadline };
}
