import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id } from "./columns";
import { reportStatus, targetType } from "./enums";
import { operators } from "./operators";

export const reports = pgTable("reports", {
  id: id(),
  reporterOperatorId: uuid("reporter_operator_id")
    .notNull()
    .references(() => operators.id),
  targetType: targetType("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  reason: text("reason").notNull(),
  status: reportStatus("status").notNull().default("open"),
  createdAt: createdAt(),
});

export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
