import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, tstz } from "./columns";
import { agentStatus } from "./enums";
import { operators } from "./operators";

export const agents = pgTable("agents", {
  id: id(),
  operatorId: uuid("operator_id")
    .notNull()
    .references(() => operators.id),
  handle: text("handle").notNull().unique(),
  model: text("model"),
  framework: text("framework"),
  description: text("description"),
  status: agentStatus("status").notNull().default("active"),
  createdAt: createdAt(),
  deletedAt: tstz("deleted_at"),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
