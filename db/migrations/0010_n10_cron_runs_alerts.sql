CREATE TABLE "cron_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cron_runs_route_finished_idx" ON "cron_runs" USING btree ("route","finished_at");--> statement-breakpoint
CREATE INDEX "alert_log_rule_created_idx" ON "alert_log" USING btree ("rule","created_at");
--> statement-breakpoint
-- Security for the two new tables, as in 0001_security.sql: RLS enabled and forced, one policy for app_server, no
-- privileges for PUBLIC. cron_runs is read, appended to and pruned (the wrapper keeps the newest rows); alert_log is
-- read and appended to. Neither is ever updated.
ALTER TABLE "cron_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cron_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "cron_runs" FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY app_server_all ON "cron_runs" FOR ALL TO app_server USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "cron_runs" TO app_server;
--> statement-breakpoint
ALTER TABLE "alert_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "alert_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "alert_log" FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY app_server_all ON "alert_log" FOR ALL TO app_server USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT ON "alert_log" TO app_server;
