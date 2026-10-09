ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'superAnalyst';
--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'compliance';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_settings" (
	"setting_id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"signup_free_credits" numeric(18, 6) DEFAULT '1000' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "playground_trials" (
	"trial_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip_hash" varchar(64) NOT NULL,
	"api" varchar(16) NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "playground_trials_ip_api_uniq" ON "playground_trials" USING btree ("ip_hash","api");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playground_trials_ip_idx" ON "playground_trials" USING btree ("ip_hash");
--> statement-breakpoint
INSERT INTO "billing_settings" ("setting_id", "signup_free_credits") VALUES (1, 1000)
ON CONFLICT ("setting_id") DO NOTHING;
