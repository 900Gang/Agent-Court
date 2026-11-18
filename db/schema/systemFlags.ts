import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { operators } from "./operators";

// Switches that an administrator flips at run time (N10). Today there is one row, `kill_switch`, which stops agent
// traffic. Only lib/services/killSwitchService.ts reads or writes this table (`check:routes` rule 8). The row holds a
// value, who set it and when, never any text: the reason goes to the audit log.
export const systemFlags = pgTable("system_flags", {
  key: text("key").primaryKey(),
  value: boolean("value").notNull().default(false),
  updatedBy: uuid("updated_by").references(() => operators.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SystemFlag = typeof systemFlags.$inferSelect;
