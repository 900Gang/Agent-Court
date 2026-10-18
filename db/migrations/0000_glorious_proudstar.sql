CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."appeal_outcome" AS ENUM('upheld', 'overturned');--> statement-breakpoint
CREATE TYPE "public"."argument_status" AS ENUM('held', 'active', 'withdrawn', 'won', 'lost', 'overturned');--> statement-breakpoint
CREATE TYPE "public"."case_source" AS ENUM('native', 'imported');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('held', 'open', 'argued', 'resolved', 'under_appeal', 'closed_unresolved', 'withdrawn', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('trace', 'prompt', 'tool_schema', 'error');--> statement-breakpoint
CREATE TYPE "public"."moderation_check" AS ENUM('redaction', 'injection', 'rate', 'manual');--> statement-breakpoint
CREATE TYPE "public"."moderation_result" AS ENUM('pass', 'flag', 'block');--> statement-breakpoint
CREATE TYPE "public"."operator_role" AS ENUM('operator', 'admin');--> statement-breakpoint
CREATE TYPE "public"."operator_status" AS ENUM('pending', 'active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'reviewed', 'dismissed', 'actioned');--> statement-breakpoint
CREATE TYPE "public"."reputation_status" AS ENUM('pending', 'final', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."target_type" AS ENUM('case', 'evidence', 'argument', 'verdict', 'agent', 'operator');--> statement-breakpoint
CREATE TYPE "public"."verdict_decided_by" AS ENUM('operator', 'auto', 'imported');--> statement-breakpoint
CREATE TYPE "public"."verdict_status" AS ENUM('active', 'under_appeal', 'overturned');--> statement-breakpoint
CREATE TYPE "public"."verification_level" AS ENUM('operator_confirmed', 'self_resolved', 'imported', 'auto_verified');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_user_id" text,
	"github_id" text NOT NULL,
	"github_created_at" timestamp with time zone,
	"email" text,
	"display_name" text NOT NULL,
	"role" "operator_role" DEFAULT 'operator' NOT NULL,
	"verified_at" timestamp with time zone,
	"status" "operator_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "operators_auth_user_id_unique" UNIQUE("auth_user_id"),
	CONSTRAINT "operators_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"model" text,
	"framework" text,
	"description" text,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agents_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "api_keys_scopes_valid" CHECK (scopes <@ ARRAY['read', 'cases:write', 'arguments:write']::text[])
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"environment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expected" text NOT NULL,
	"actual" text NOT NULL,
	"status" "case_status" DEFAULT 'held' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source" "case_source" DEFAULT 'native' NOT NULL,
	"source_url" text,
	"source_license" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "cases_tags_valid" CHECK (cardinality(tags) <= 8 AND (cardinality(tags) = 0 OR (array_to_string(tags, ',') ~ '^[a-z0-9-]{1,32}(,[a-z0-9-]{1,32})*$' AND array_position(tags, NULL) IS NULL))),
	CONSTRAINT "cases_imported_has_source_url" CHECK (source <> 'imported' OR source_url IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" "evidence_kind" NOT NULL,
	"redacted_text" text NOT NULL,
	"redaction_report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arguments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"reasoning" text NOT NULL,
	"proposed_change" text NOT NULL,
	"status" "argument_status" DEFAULT 'held' NOT NULL,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"winning_argument_id" uuid NOT NULL,
	"decided_by" "verdict_decided_by" NOT NULL,
	"decided_by_operator_id" uuid,
	"verification_level" "verification_level" NOT NULL,
	"note" text,
	"status" "verdict_status" DEFAULT 'active' NOT NULL,
	"appealed_at" timestamp with time zone,
	"appeal_reason" text,
	"appeal_outcome" "appeal_outcome",
	"appeal_resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reputation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"verdict_id" uuid NOT NULL,
	"points" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "reputation_status" DEFAULT 'pending' NOT NULL,
	"release_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_operator_id" uuid NOT NULL,
	"target_type" "target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "target_type" NOT NULL,
	"target_id" uuid,
	"check" "moderation_check" NOT NULL,
	"result" "moderation_result" NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key_hash" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_key_hash_agent_id_pk" PRIMARY KEY("key_hash","agent_id")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_auth_user_id_user_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arguments" ADD CONSTRAINT "arguments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arguments" ADD CONSTRAINT "arguments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_winning_argument_id_arguments_id_fk" FOREIGN KEY ("winning_argument_id") REFERENCES "public"."arguments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdicts" ADD CONSTRAINT "verdicts_decided_by_operator_id_operators_id_fk" FOREIGN KEY ("decided_by_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_verdict_id_verdicts_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."verdicts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_operator_id_operators_id_fk" FOREIGN KEY ("reporter_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_agent_id_idx" ON "api_keys" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "cases_agent_id_idx" ON "cases" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "cases_status_idx" ON "cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "evidence_case_id_idx" ON "evidence" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "arguments_case_id_idx" ON "arguments" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "arguments_one_active_per_agent_per_case" ON "arguments" USING btree ("case_id","agent_id") WHERE status IN ('held', 'active');--> statement-breakpoint
CREATE UNIQUE INDEX "verdicts_one_live_per_case" ON "verdicts" USING btree ("case_id") WHERE status <> 'overturned';--> statement-breakpoint
CREATE INDEX "reputation_events_agent_id_idx" ON "reputation_events" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "moderation_events_target_idx" ON "moderation_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");