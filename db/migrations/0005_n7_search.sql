CREATE TABLE "case_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"model" text NOT NULL,
	"dim" integer NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"text_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_embeddings_case_model_unique" UNIQUE("case_id","model")
);
--> statement-breakpoint
CREATE TABLE "search_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"query_redacted" text NOT NULL,
	"result_count" integer NOT NULL,
	"resolved_hit" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_events_query_length" CHECK (char_length("search_events"."query_redacted") <= 200)
);
--> statement-breakpoint
ALTER TABLE "case_embeddings" ADD CONSTRAINT "case_embeddings_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_events" ADD CONSTRAINT "search_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_embeddings_embedding_hnsw" ON "case_embeddings" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
-- Full-text search over a case: title weighs most, then tags and summary, then expected and actual. A function
-- marked immutable is needed because array_to_string is only stable, and a generated column needs an immutable
-- expression. For a text array its result never depends on anything but the input.
CREATE FUNCTION "cases_search_vector"("title" text, "summary" text, "expected" text, "actual" text, "tags" text[])
RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT setweight(to_tsvector('english'::regconfig, coalesce($1, '')), 'A')
      || setweight(to_tsvector('english'::regconfig, coalesce(array_to_string($5, ' '), '')), 'B')
      || setweight(to_tsvector('english'::regconfig, coalesce($2, '')), 'B')
      || setweight(to_tsvector('english'::regconfig, coalesce($3, '')), 'C')
      || setweight(to_tsvector('english'::regconfig, coalesce($4, '')), 'C')
$$;
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS ("cases_search_vector"("title", "summary", "expected", "actual", "tags")) STORED;
--> statement-breakpoint
CREATE INDEX "cases_search_tsv_idx" ON "cases" USING gin ("search_tsv");
--> statement-breakpoint

-- Security for the new tables, as in 0001_security.sql: RLS enabled and forced, one policy for app_server, no
-- privileges for PUBLIC. case_embeddings can be updated (a stale vector is replaced); search_events is append-only.
ALTER TABLE "case_embeddings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_embeddings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "case_embeddings" FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY app_server_all ON "case_embeddings" FOR ALL TO app_server USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "case_embeddings" TO app_server;
--> statement-breakpoint
ALTER TABLE "search_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "search_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "search_events" FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY app_server_all ON "search_events" FOR ALL TO app_server USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT ON "search_events" TO app_server;
