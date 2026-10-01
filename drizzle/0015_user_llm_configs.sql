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
