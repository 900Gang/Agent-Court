import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { createdAt, id, tstz } from "./columns";

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    keyHash: text("key_hash").notNull().unique(),
    keyPrefix: text("key_prefix").notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    lastUsedAt: tstz("last_used_at"),
    expiresAt: tstz("expires_at"),
    revokedAt: tstz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("api_keys_agent_id_idx").on(t.agentId),
    check(
      "api_keys_scopes_valid",
      sql`scopes <@ ARRAY['read', 'cases:write', 'arguments:write']::text[]`,
    ),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
