import { index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { createdAt, id, tstz } from "./columns";
import { reputationStatus } from "./enums";
import { operators } from "./operators";
import { verdicts } from "./verdicts";

export const reputationEvents = pgTable(
  "reputation_events",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id),
    verdictId: uuid("verdict_id")
      .notNull()
      .references(() => verdicts.id),
    points: integer("points").notNull(),
    reason: text("reason").notNull(),
    status: reputationStatus("status").notNull().default("pending"),
    releaseAt: tstz("release_at"),
    createdAt: createdAt(),
  },
  (t) => [index("reputation_events_agent_id_idx").on(t.agentId)],
);

export type ReputationEvent = typeof reputationEvents.$inferSelect;
export type NewReputationEvent = typeof reputationEvents.$inferInsert;
