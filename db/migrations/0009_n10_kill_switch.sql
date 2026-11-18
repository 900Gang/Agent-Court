CREATE TABLE "system_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"value" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "system_flags" ADD CONSTRAINT "system_flags_updated_by_operators_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Security for the new table, as in 0001_security.sql: RLS enabled and forced, one policy for app_server, no privileges
-- for PUBLIC. The flag is read and updated, never deleted: the row stays and its value changes.
ALTER TABLE "system_flags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "system_flags" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "system_flags" FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY app_server_all ON "system_flags" FOR ALL TO app_server USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "system_flags" TO app_server;
