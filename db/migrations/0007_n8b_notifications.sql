CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_log_once" ON "notification_log" USING btree ("kind","target_id","operator_id");
--> statement-breakpoint
-- Security for the new table, as in 0001_security.sql: RLS enabled and forced, one policy for app_server, no privileges
-- for PUBLIC. A notice that failed to send gives its claim back by deleting the row; rows are never updated.
ALTER TABLE "notification_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "notification_log" FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY app_server_all ON "notification_log" FOR ALL TO app_server USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "notification_log" TO app_server;
