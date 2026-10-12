-- This migration consolidates changes from older branches. Keep it safe for
-- databases where some of these objects were created before migration history
-- was synchronized.
CREATE TABLE IF NOT EXISTS "user_llm_configs" (
  "config_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_uuid" uuid NOT NULL UNIQUE REFERENCES "users"("user_uuid") ON DELETE CASCADE,
  "provider" varchar(32) NOT NULL,
  "model_name" varchar(128) NOT NULL,
  "endpoint" varchar(500),
  "api_key" varchar(1000) NOT NULL,
  "temperature" numeric(4, 2) DEFAULT '0.7' NOT NULL,
  "max_tokens" integer DEFAULT 1024 NOT NULL,
  "top_p" numeric(4, 2) DEFAULT '1' NOT NULL,
  "timeout_ms" integer DEFAULT 30000 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
  "key_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_uuid" uuid NOT NULL REFERENCES "users"("user_uuid") ON DELETE CASCADE,
  "name" varchar(100) NOT NULL,
  "key_prefix" varchar(24) NOT NULL,
  "key_hash" varchar(64) NOT NULL UNIQUE,
  "scopes" jsonb DEFAULT '["stt","tts","llm"]'::jsonb NOT NULL,
  "last_used_at" timestamp,
  "expires_at" timestamp,
  "revoked_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_id" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "microsoft_id" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "apple_id" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_provider" varchar(32) DEFAULT 'email' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_llm_configs_user_uuid_users_user_uuid_fk') THEN
    ALTER TABLE "user_llm_configs" ADD CONSTRAINT "user_llm_configs_user_uuid_users_user_uuid_fk" FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_user_uuid_users_user_uuid_fk') THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_uuid_users_user_uuid_fk" FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_user_idx" ON "api_keys" USING btree ("user_uuid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_google_id_unique" ON "users" ("google_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_microsoft_id_unique" ON "users" ("microsoft_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_apple_id_unique" ON "users" ("apple_id");
