import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { createdAt, id } from "./columns";

// One row per API search. The query is stored only after redaction, never raw (threat T10).
export const searchEvents = pgTable(
  "search_events",
  {
    id: id(),
    agentId: uuid("agent_id").references(() => agents.id),
    queryRedacted: text("query_redacted").notNull(),
    resultCount: integer("result_count").notNull(),
    resolvedHit: boolean("resolved_hit").notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("search_events_query_length", sql`char_length(${t.queryRedacted}) <= 200`)],
);

export type SearchEvent = typeof searchEvents.$inferSelect;
export type NewSearchEvent = typeof searchEvents.$inferInsert;
