ALTER TABLE "api_keys" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_label_length" CHECK (char_length(label) <= 60);