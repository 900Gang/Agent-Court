import { pgTable, text } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, id, tstz } from "./columns";
import { operatorRole, operatorStatus } from "./enums";

export const operators = pgTable("operators", {
  id: id(),
  authUserId: text("auth_user_id")
    .unique()
    .references(() => user.id, { onDelete: "set null" }),
  githubId: text("github_id").notNull().unique(),
  githubCreatedAt: tstz("github_created_at"),
  email: text("email"),
  displayName: text("display_name").notNull(),
  role: operatorRole("role").notNull().default("operator"),
  verifiedAt: tstz("verified_at"),
  status: operatorStatus("status").notNull().default("pending"),
  createdAt: createdAt(),
  deletedAt: tstz("deleted_at"),
});

export type Operator = typeof operators.$inferSelect;
export type NewOperator = typeof operators.$inferInsert;
