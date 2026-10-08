CREATE TABLE IF NOT EXISTS "voice_bots" (
  "bot_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_uuid" uuid NOT NULL REFERENCES "users"("user_uuid") ON DELETE CASCADE,
  "name" varchar(120) NOT NULL,
  "system_prompt" text NOT NULL,
  "greeting" text DEFAULT '' NOT NULL,
  "language" varchar(8) DEFAULT 'hi' NOT NULL,
  "stt_mode" varchar(16) DEFAULT 'native' NOT NULL,
  "end_silence_ms" integer DEFAULT 700 NOT NULL,
  "voice_mode" varchar(16) DEFAULT 'default' NOT NULL,
  "voice_id" varchar(255),
  "speed" real DEFAULT 1 NOT NULL,
  "pitch" real DEFAULT 1 NOT NULL,
  "temperature" real DEFAULT 0.4 NOT NULL,
  "barge_in" boolean DEFAULT true NOT NULL,
  "silence_timeout_s" integer DEFAULT 15 NOT NULL,
  "max_duration_s" integer DEFAULT 600 NOT NULL,
  "handoff_enabled" boolean DEFAULT true NOT NULL,
  "handoff_message" text DEFAULT '' NOT NULL,
  "goodbye_message" text DEFAULT '' NOT NULL,
  "tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_bots_user_idx" ON "voice_bots" USING btree ("user_uuid");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_bot_connections" (
  "connection_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_uuid" uuid NOT NULL REFERENCES "users"("user_uuid") ON DELETE CASCADE,
  "name" varchar(120) NOT NULL,
  "token_prefix" varchar(24) NOT NULL,
  "token_hash" varchar(64) NOT NULL UNIQUE,
  "allowed_ips" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "callback_url" varchar(500),
  "callback_token" varchar(255),
  "playback_mode" varchar(16) DEFAULT 'json' NOT NULL,
  "sample_rate" integer DEFAULT 16000 NOT NULL,
  "revoked_at" timestamp,
  "last_used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_bot_connections_user_idx" ON "voice_bot_connections" USING btree ("user_uuid");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_calls" (
  "call_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_uuid" uuid NOT NULL REFERENCES "users"("user_uuid") ON DELETE CASCADE,
  "bot_uuid" uuid REFERENCES "voice_bots"("bot_uuid") ON DELETE SET NULL,
  "connection_uuid" uuid REFERENCES "voice_bot_connections"("connection_uuid") ON DELETE SET NULL,
  "external_call_id" varchar(128),
  "caller" varchar(64),
  "callee" varchar(64),
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" varchar(24) DEFAULT 'active' NOT NULL,
  "end_reason" varchar(48),
  "summary" text,
  "handoff_target" varchar(255),
  "duration_seconds" real DEFAULT 0 NOT NULL,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "ended_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_calls_user_started_idx" ON "voice_calls" USING btree ("user_uuid","started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_calls_external_idx" ON "voice_calls" USING btree ("external_call_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_call_turns" (
  "turn_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "call_uuid" uuid NOT NULL REFERENCES "voice_calls"("call_uuid") ON DELETE CASCADE,
  "turn_index" integer NOT NULL,
  "role" varchar(16) NOT NULL,
  "text" text NOT NULL,
  "interrupted" boolean DEFAULT false NOT NULL,
  "latency_ms" integer,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "voice_call_turns_call_index_unique" ON "voice_call_turns" USING btree ("call_uuid","turn_index");
