import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, uuid } from "drizzle-orm/pg-core";
import { createdAt, id } from "./columns";
import { moderationCheck, moderationResult, targetType } from "./enums";

// details must never contain a matched secret value (threat T2, T10).
export const moderationEvents = pgTable(
  "moderation_events",
  {
    id: id(),
    targetType: targetType("target_type").notNull(),
    // Null when the content was blocked and never stored.
    targetId: uuid("target_id"),
    check: moderationCheck("check").notNull(),
    result: moderationResult("result").notNull(),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("moderation_events_target_idx").on(t.targetType, t.targetId)],
);

export type ModerationEvent = typeof moderationEvents.$inferSelect;
export type NewModerationEvent = typeof moderationEvents.$inferInsert;
