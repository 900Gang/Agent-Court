import { index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt, id } from "./columns";

// One row per alert that was sent (N10, Task 5). The newest row of a rule decides whether the rule is still cooling down.
// It holds the rule name and the numbers that fired it, never any text.
export const alertLog = pgTable(
  "alert_log",
  {
    id: id(),
    rule: text("rule").notNull(),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("alert_log_rule_created_idx").on(t.rule, t.createdAt)],
);

export type AlertLogEntry = typeof alertLog.$inferSelect;
