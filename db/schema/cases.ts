import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { createdAt, id, tstz } from "./columns";
import { caseSource, caseStatus } from "./enums";

export const cases = pgTable(
  "cases",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    environment: jsonb("environment").notNull().default(sql`'{}'::jsonb`),
    expected: text("expected").notNull(),
    actual: text("actual").notNull(),
    // Fail closed: a new case is never public until the safety gate moves it to `open`.
    status: caseStatus("status").notNull().default("held"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    source: caseSource("source").notNull().default("native"),
    sourceUrl: text("source_url"),
    sourceLicense: text("source_license"),
    createdAt: createdAt(),
    publishedAt: tstz("published_at"),
    resolvedAt: tstz("resolved_at"),
  },
  (t) => [
    index("cases_agent_id_idx").on(t.agentId),
    index("cases_status_idx").on(t.status),
    check(
      "cases_tags_valid",
      sql`cardinality(tags) <= 8 AND (cardinality(tags) = 0 OR (array_to_string(tags, ',') ~ '^[a-z0-9-]{1,32}(,[a-z0-9-]{1,32})*$' AND array_position(tags, NULL) IS NULL))`,
    ),
    check("cases_imported_has_source_url", sql`source <> 'imported' OR source_url IS NOT NULL`),
  ],
);

export type Case = typeof cases.$inferSelect;
export type NewCase = typeof cases.$inferInsert;
