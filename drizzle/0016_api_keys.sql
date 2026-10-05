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
CREATE INDEX IF NOT EXISTS "api_keys_user_idx" ON "api_keys" USING btree ("user_uuid");
