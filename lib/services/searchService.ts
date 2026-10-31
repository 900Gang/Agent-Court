import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { agents, argumentsTable, caseEmbeddings, cases } from "@/db/schema";
import type { Database } from "@/db/types";
import { EMBEDDING, PUBLIC_CASE_STATUSES, SEARCH_TUNING } from "@/lib/config/constants";
import type { EmbeddingProvider } from "@/lib/embeddings/provider";
import { prepareQuery } from "@/lib/search/query";
import { fuse, resolvedFirst } from "@/lib/search/rank";
import type { SearchQuery } from "@/lib/schemas/search";
import type { CaseListItem } from "@/lib/serializers/toAgentView";

const PUBLIC = [...PUBLIC_CASE_STATUSES];

/** The query is text, not a pattern: LIKE wildcards and the escape character are matched literally. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

export type SearchDeps = {
  /** The embeddings provider. Without one, only the keyword leg runs. */
  provider?: EmbeddingProvider | null;
  timeoutMs?: number;
  /** Which legs to run. Both by default. Only the duplicate-recall evaluation sets it, to score each leg alone. */
  legs?: ReadonlyArray<"keyword" | "vector">;
};

/**
 * Keyword leg: full text search over title, tags, summary, expected and actual (the title counts most), best first,
 * newest first among equals. When full text finds nothing, a literal substring match on title and summary fills in, so
 * a partial word or an identifier still matches. Public cases only.
 */
async function keywordLeg(db: Database, text: string): Promise<string[]> {
  const tsquery = sql`websearch_to_tsquery('english', ${text})`;
  const matches = await db
    .select({ id: cases.id })
    .from(cases)
    .where(and(inArray(cases.status, PUBLIC), sql`"cases"."search_tsv" @@ ${tsquery}`))
    .orderBy(sql`ts_rank_cd("cases"."search_tsv", ${tsquery}) desc`, desc(cases.createdAt), desc(cases.id))
    .limit(SEARCH_TUNING.legSize);
  if (matches.length > 0) return matches.map((row) => row.id);

  const pattern = `%${escapeLike(text)}%`;
  const fallback = await db
    .select({ id: cases.id })
    .from(cases)
    .where(and(inArray(cases.status, PUBLIC), or(ilike(cases.title, pattern), ilike(cases.summary, pattern))))
    .orderBy(desc(cases.createdAt), desc(cases.id))
    .limit(SEARCH_TUNING.legSize);
  return fallback.map((row) => row.id);
}

/**
 * Vector leg: the public cases whose stored vector is nearest to the query's, above a similarity floor. A provider that
 * is off, slow, failing or answering with something odd gives an empty leg, never an error.
 */
async function vectorLeg(db: Database, provider: EmbeddingProvider, text: string, timeoutMs: number | undefined): Promise<string[]> {
  let vector: number[] | undefined;
  try {
    vector = (await provider.embed([text], { timeoutMs: timeoutMs ?? EMBEDDING.requestTimeoutMs }))[0];
  } catch {
    return [];
  }
  if (!Array.isArray(vector) || vector.length !== provider.dimensions || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) return [];

  const distance = sql`${caseEmbeddings.embedding} <=> ${`[${vector.join(",")}]`}::vector`;
  const rows = await db
    .select({ id: cases.id })
    .from(caseEmbeddings)
    .innerJoin(cases, eq(cases.id, caseEmbeddings.caseId))
    .where(and(eq(caseEmbeddings.model, provider.model), inArray(cases.status, PUBLIC), sql`${distance} <= ${1 - SEARCH_TUNING.vectorMinSimilarity}`))
    .orderBy(distance, desc(cases.id))
    .limit(SEARCH_TUNING.legSize);
  return rows.map((row) => row.id);
}

export async function loadItems(db: Database, ids: string[]): Promise<Map<string, CaseListItem>> {
  const rows = await db
    .select({
      row: cases,
      handle: agents.handle,
      argumentCount: sql<number>`(select count(*)::int from ${argumentsTable}
        where ${argumentsTable.caseId} = ${cases.id} and ${argumentsTable.status} in ('active', 'won'))`,
    })
    .from(cases)
    .innerJoin(agents, eq(agents.id, cases.agentId))
    .where(and(inArray(cases.id, ids), inArray(cases.status, PUBLIC)));
  return new Map(rows.map((entry) => [entry.row.id, { case: entry.row, filedBy: { handle: entry.handle }, argumentCount: entry.argumentCount }]));
}

async function rankedSearch(db: Database, { query, limit }: SearchQuery, deps: SearchDeps): Promise<CaseListItem[]> {
  const prepared = prepareQuery(query);
  if (!prepared.searchable) return [];

  const legs = deps.legs ?? ["keyword", "vector"];
  const [keyword, vector] = await Promise.all([
    legs.includes("keyword") ? keywordLeg(db, prepared.text) : Promise.resolve<string[]>([]),
    legs.includes("vector") && deps.provider ? vectorLeg(db, deps.provider, prepared.text, deps.timeoutMs) : Promise.resolve<string[]>([]),
  ]);
  const fused = fuse([keyword, vector], SEARCH_TUNING.rrfK);
  if (fused.length === 0) return [];

  const items = await loadItems(db, fused.map((entry) => entry.id));
  const ordered = fused.flatMap((entry) => {
    const item = items.get(entry.id);
    return item ? [item] : [];
  });
  return resolvedFirst(ordered, (item) => item.case.status === "resolved").slice(0, limit);
}

/**
 * Search over public cases (N7): a keyword leg and, when a provider is given, a vector leg, fused by reciprocal rank
 * fusion, resolved cases first. Held, withdrawn and rejected cases never match, whoever asks, so the viewer does not
 * change the answer. Results are list items only: no vector and no score leave this function.
 */
export async function searchCases(
  db: Database,
  _viewerAgentId: string,
  query: SearchQuery,
  deps: SearchDeps = {},
): Promise<CaseListItem[]> {
  return rankedSearch(db, query, deps);
}

/** The keyword leg alone, for the public search page. It never touches the embeddings provider. */
export async function searchKeyword(db: Database, query: SearchQuery): Promise<CaseListItem[]> {
  return rankedSearch(db, query, {});
}
