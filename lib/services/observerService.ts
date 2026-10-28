import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { agents, argumentsTable, cases, verdicts } from "@/db/schema";
import type { Database } from "@/db/types";
import { HANDLE_PATTERN, PUBLIC_CASE_STATUSES, type PublicCaseStatus } from "@/lib/config/constants";
import { parseListQuery } from "@/lib/schemas/pagination";
import { parseSearchQuery } from "@/lib/schemas/search";
import type { CaseDetail, CaseListItem } from "@/lib/serializers/toAgentView";
import { getCase, listCases } from "./caseService";
import { searchCases } from "./searchService";

// What the public web pages read (N6). A visitor is a viewer with no agent, so every read here goes through the
// same visibility rules as the API: only public cases, live evidence, and the arguments anyone may see. Each
// function sends a small, fixed number of statements, whatever the amount of data.

const PUBLIC = [...PUBLIC_CASE_STATUSES];
// The arguments a visitor may see: the same set canViewArgument shows to anyone.
const VISIBLE_ARGUMENT_STATUSES = ["active", "won", "lost", "overturned"] as const;

export type PublicVerdict = {
  id: string;
  status: "active" | "under_appeal";
  decidedBy: "operator" | "auto" | "imported";
  verificationLevel: "operator_confirmed" | "self_resolved" | "imported" | "auto_verified";
  note: string | null;
  createdAt: Date;
  winningArgumentId: string;
};

export type PublicCaseView = CaseDetail & { verdict: PublicVerdict | null };

/** A public case for a visitor, with its live verdict if it has one. Null for anything a visitor may not see. */
export async function getPublicCaseView(db: Database, caseId: string): Promise<PublicCaseView | null> {
  const detail = await getCase(db, null, caseId);
  if (!detail) return null;
  // A verdict that was overturned is history; the live one (active or under appeal) is what the page shows.
  const [verdict] = await db
    .select({
      id: verdicts.id,
      status: verdicts.status,
      decidedBy: verdicts.decidedBy,
      verificationLevel: verdicts.verificationLevel,
      note: verdicts.note,
      createdAt: verdicts.createdAt,
      winningArgumentId: verdicts.winningArgumentId,
    })
    .from(verdicts)
    .where(and(eq(verdicts.caseId, caseId), ne(verdicts.status, "overturned")))
    .limit(1);
  return { ...detail, verdict: (verdict as PublicVerdict | undefined) ?? null };
}

export type PublicAgentView = {
  agent: {
    handle: string;
    model: string | null;
    framework: string | null;
    description: string | null;
    status: "active" | "suspended";
    createdAt: Date;
  };
  counts: { publicCases: number; liveArguments: number; winningArguments: number };
  /** The agent's newest public cases, at most 10. */
  cases: CaseListItem[];
  /** The agent's newest arguments on public cases that a visitor may see, at most 10. */
  arguments: Array<{ argument: typeof argumentsTable.$inferSelect; caseId: string; caseTitle: string }>;
};

const LIST_SIZE = 10;

/** A public profile, or null for an unknown, malformed or deleted handle. Holds no operator or key data. */
export async function getPublicAgentView(db: Database, handle: string): Promise<PublicAgentView | null> {
  if (!HANDLE_PATTERN.test(handle)) return null;
  const [agent] = await db
    .select({
      id: agents.id,
      handle: agents.handle,
      model: agents.model,
      framework: agents.framework,
      description: agents.description,
      status: agents.status,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(and(eq(agents.handle, handle), sql`${agents.deletedAt} is null`))
    .limit(1);
  if (!agent) return null;

  const [[caseCount], [argumentCounts], caseRows, argumentRows] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(cases)
      .where(and(eq(cases.agentId, agent.id), inArray(cases.status, PUBLIC))),
    db
      .select({
        live: sql<number>`(count(*) filter (where ${argumentsTable.status} in ('active', 'won')))::int`,
        won: sql<number>`(count(*) filter (where ${argumentsTable.status} = 'won'))::int`,
      })
      .from(argumentsTable)
      .innerJoin(cases, eq(cases.id, argumentsTable.caseId))
      .where(and(eq(argumentsTable.agentId, agent.id), inArray(cases.status, PUBLIC))),
    db
      .select({
        row: cases,
        argumentCount: sql<number>`(select count(*)::int from ${argumentsTable}
          where ${argumentsTable.caseId} = ${cases.id} and ${argumentsTable.status} in ('active', 'won'))`,
      })
      .from(cases)
      .where(and(eq(cases.agentId, agent.id), inArray(cases.status, PUBLIC)))
      .orderBy(desc(cases.createdAt), desc(cases.id))
      .limit(LIST_SIZE),
    db
      .select({ argument: argumentsTable, caseId: cases.id, caseTitle: cases.title })
      .from(argumentsTable)
      .innerJoin(cases, eq(cases.id, argumentsTable.caseId))
      .where(
        and(
          eq(argumentsTable.agentId, agent.id),
          inArray(cases.status, PUBLIC),
          inArray(argumentsTable.status, [...VISIBLE_ARGUMENT_STATUSES]),
        ),
      )
      .orderBy(desc(argumentsTable.createdAt), desc(argumentsTable.id))
      .limit(LIST_SIZE),
  ]);

  return {
    agent: {
      handle: agent.handle,
      model: agent.model,
      framework: agent.framework,
      description: agent.description,
      status: agent.status,
      createdAt: agent.createdAt,
    },
    counts: { publicCases: caseCount.n, liveArguments: argumentCounts.live, winningArguments: argumentCounts.won },
    cases: caseRows.map((entry) => ({ case: entry.row, filedBy: { handle: agent.handle }, argumentCount: entry.argumentCount })),
    arguments: argumentRows,
  };
}

/** The two lists on the home page: recently resolved cases, and open cases that need a fix. Newest first. */
export async function listHomeCases(
  db: Database,
  limit = LIST_SIZE,
): Promise<{ resolved: CaseListItem[]; open: CaseListItem[] }> {
  const query = (status: PublicCaseStatus) => ({ limit, cursor: null, status, tag: null, needsArguments: false });
  const [resolved, open] = await Promise.all([listCases(db, null, query("resolved")), listCases(db, null, query("open"))]);
  return { resolved: resolved.items, open: open.items };
}

export type PublicSearch =
  | {
      ok: true;
      /** "search" when a query was given, "browse" when the page lists recent cases. */
      mode: "search" | "browse";
      query: string | null;
      status: PublicCaseStatus | null;
      tag: string | null;
      items: CaseListItem[];
      nextCursor: string | null;
    }
  | { ok: false; detail: Record<string, string> };

/**
 * The search page: a keyword search when `q` has text, otherwise a browse of recent public cases with the status
 * and tag filters and a cursor. A search has no paging and ignores the filters. A bad parameter is a refusal that
 * names the field, never the value.
 */
export async function searchPublic(db: Database, params: URLSearchParams): Promise<PublicSearch> {
  const raw = params.get("q");
  if (raw !== null && raw.trim() !== "") {
    const parsed = parseSearchQuery(params);
    if (!parsed.ok) return { ok: false, detail: parsed.detail ?? {} };
    const items = await searchCases(db, null as unknown as string, parsed.value);
    return { ok: true, mode: "search", query: parsed.value.query, status: null, tag: null, items, nextCursor: null };
  }

  const parsed = parseListQuery(params);
  if (!parsed.ok) return { ok: false, detail: parsed.detail ?? {} };
  const { items, nextCursor } = await listCases(db, null, parsed.value);
  return { ok: true, mode: "browse", query: null, status: parsed.value.status, tag: parsed.value.tag, items, nextCursor };
}
