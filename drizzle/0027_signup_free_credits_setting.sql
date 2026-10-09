CREATE TABLE IF NOT EXISTS "billing_settings" (
	"setting_id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"signup_free_credits" numeric(18, 6) DEFAULT '1000' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_settings_singleton_check" CHECK ("setting_id" = 1),
	CONSTRAINT "billing_settings_signup_free_credits_nonnegative" CHECK ("signup_free_credits" >= 0)
);
--> statement-breakpoint
INSERT INTO "billing_settings" ("setting_id", "signup_free_credits") VALUES (1, 1000)
ON CONFLICT ("setting_id") DO NOTHING;
