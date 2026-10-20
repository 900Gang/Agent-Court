import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { cases } from "./cases";
import { createdAt, id } from "./columns";
import { evidenceKind, evidenceStatus } from "./enums";

// Only redacted text is stored. There is deliberately no column for raw content.
export const evidence = pgTable(
  "evidence",
  {
    id: id(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id),
    kind: evidenceKind("kind").notNull(),
    status: evidenceStatus("status").notNull().default("held"),
    redactedText: text("redacted_text").notNull(),
    redactionReport: jsonb("redaction_report").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("evidence_case_id_idx").on(t.caseId)],
);

export type Evidence = typeof evidence.$inferSelect;
export type NewEvidence = typeof evidence.$inferInsert;
