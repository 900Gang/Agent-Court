import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { agents, argumentsTable, cases } from "@/db/schema";
import type { Database } from "@/db/types";
import { PUBLIC_CASE_STATUSES } from "@/lib/config/constants";
import type { SearchQuery } from "@/lib/schemas/search";
import type { CaseListItem } from "@/lib/serializers/toAgentView";

/** The query is text, not a pattern: LIKE wildcards and the escape character are matched literally. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

/**
 * Keyword search over public cases (N5). A case matches when the query is inside its title or summary, ignoring
 * letter case, or equals one of its tags. Held, withdrawn and rejected cases never match, whoever asks: search is
 * a public view, so the viewer does not change the answer. Newest first, no paging. N7 replaces the matching with
 * hybrid ranking and keeps this signature.
 */
export async function searchCases(
  db: Database,
  _viewerAgentId: string,
  { query, limit }: SearchQuery,
): Promise<CaseListItem[]> {
  const pattern = `%${escapeLike(query)}%`;
  const rows = await db
    .select({
      row: cases,
      handle: agents.handle,
      argumentCount: sql<number>`(select count(*)::int from ${argumentsTable}
        where ${argumentsTable.caseId} = ${cases.id} and ${argumentsTable.status} in ('active', 'won'))`,
    })
    .from(cases)
    .innerJoin(agents, eq(agents.id, cases.agentId))
    .where(
      and(
        inArray(cases.status, [...PUBLIC_CASE_STATUSES]),
        or(ilike(cases.title, pattern), ilike(cases.summary, pattern), sql`${query.toLowerCase()} = ANY(${cases.tags})`),
      ),
    )
    .orderBy(desc(cases.createdAt), desc(cases.id))
    .limit(limit);

  return rows.map((entry) => ({
    case: entry.row,
    filedBy: { handle: entry.handle },
    argumentCount: entry.argumentCount,
  }));
}
