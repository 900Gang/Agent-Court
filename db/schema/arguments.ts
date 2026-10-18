import { sql } from "drizzle-orm";
import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { cases } from "./cases";
import { createdAt, id, tstz } from "./columns";
import { argumentStatus } from "./enums";

// Exported as argumentsTable because `arguments` is a reserved identifier in strict mode.
export const argumentsTable = pgTable(
  "arguments",
  {
    id: id(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    reasoning: text("reasoning").notNull(),
    proposedChange: text("proposed_change").notNull(),
    status: argumentStatus("status").notNull().default("held"),
    redactedAt: tstz("redacted_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("arguments_case_id_idx").on(t.caseId),
    uniqueIndex("arguments_one_active_per_agent_per_case")
      .on(t.caseId, t.agentId)
      .where(sql`status IN ('held', 'active')`),
  ],
);

export type Argument = typeof argumentsTable.$inferSelect;
export type NewArgument = typeof argumentsTable.$inferInsert;
