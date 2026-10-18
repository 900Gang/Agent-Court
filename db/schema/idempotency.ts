import { pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { createdAt } from "./columns";

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    keyHash: text("key_hash").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    requestHash: text("request_hash").notNull(),
    responseRef: text("response_ref"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.keyHash, t.agentId] })],
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
