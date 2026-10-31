import { index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
  (t) => [
    index("reputation_events_agent_id_idx").on(t.agentId),
    // A verdict pays at most once, whatever happens to the event afterwards: a reversed event does not free the verdict.
    uniqueIndex("reputation_events_verdict_id_unique").on(t.verdictId),
  ],
);

export type ReputationEvent = typeof reputationEvents.$inferSelect;
export type NewReputationEvent = typeof reputationEvents.$inferInsert;
