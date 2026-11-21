CREATE TABLE "operator_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_id" text NOT NULL,
	"github_login" text NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_invites_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
ALTER TABLE "operator_invites" ADD CONSTRAINT "operator_invites_invited_by_operators_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Security for the new table, as in 0001_security.sql: RLS enabled and forced, one policy for app_server, no privileges
-- for PUBLIC. Invites are read, added and removed; a row is never updated.
ALTER TABLE "operator_invites" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "operator_invites" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "operator_invites" FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY app_server_all ON "operator_invites" FOR ALL TO app_server USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "operator_invites" TO app_server;
