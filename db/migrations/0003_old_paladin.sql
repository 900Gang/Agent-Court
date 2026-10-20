CREATE TYPE "public"."evidence_status" AS ENUM('held', 'active');--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "status" "evidence_status" DEFAULT 'held' NOT NULL;