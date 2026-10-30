import { index, integer, pgTable, text, unique, uuid, vector } from "drizzle-orm/pg-core";
import { cases } from "./cases";
import { createdAt, id } from "./columns";

// One vector per case and model, so the model can change later without touching cases. The vector never leaves the
// database: no serializer, view or route reads this column. A case is current when text_hash equals the hash of its text.
export const caseEmbeddings = pgTable(
  "case_embeddings",
  {
    id: id(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id),
    model: text("model").notNull(),
    dim: integer("dim").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    textHash: text("text_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("case_embeddings_case_model_unique").on(t.caseId, t.model),
    index("case_embeddings_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export type CaseEmbedding = typeof caseEmbeddings.$inferSelect;
export type NewCaseEmbedding = typeof caseEmbeddings.$inferInsert;
