CREATE TYPE "public"."stt_output_mode" AS ENUM('native', 'mixed', 'romanized');--> statement-breakpoint
CREATE TYPE "public"."stt_session_status" AS ENUM('created', 'connecting', 'streaming', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "stt_segments" (
	"segment_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_uuid" uuid NOT NULL,
	"segment_index" integer NOT NULL,
	"text" text NOT NULL,
	"language" varchar(8) NOT NULL,
	"start_seconds" real NOT NULL,
	"end_seconds" real NOT NULL,
	"audio_seconds" real NOT NULL,
	"decode_ms" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"reason" varchar(32) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stt_sessions" (
	"session_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_uuid" uuid NOT NULL,
	"language" varchar(8) DEFAULT 'hi' NOT NULL,
	"output_mode" "stt_output_mode" DEFAULT 'native' NOT NULL,
	"sample_rate" integer DEFAULT 16000 NOT NULL,
	"end_silence_ms" integer DEFAULT 700 NOT NULL,
	"partials" boolean DEFAULT true NOT NULL,
	"status" "stt_session_status" DEFAULT 'created' NOT NULL,
	"transcript" text DEFAULT '' NOT NULL,
	"phrase_count" integer DEFAULT 0 NOT NULL,
	"audio_duration_seconds" real DEFAULT 0 NOT NULL,
	"error_code" varchar(100),
	"error_message" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stt_segments" ADD CONSTRAINT "stt_segments_session_uuid_stt_sessions_session_uuid_fk" FOREIGN KEY ("session_uuid") REFERENCES "public"."stt_sessions"("session_uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stt_sessions" ADD CONSTRAINT "stt_sessions_user_uuid_users_user_uuid_fk" FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stt_segments_session_index_unique" ON "stt_segments" USING btree ("session_uuid","segment_index");--> statement-breakpoint
CREATE INDEX "stt_segments_session_created_idx" ON "stt_segments" USING btree ("session_uuid","created_at");--> statement-breakpoint
CREATE INDEX "stt_sessions_user_created_idx" ON "stt_sessions" USING btree ("user_uuid","created_at");--> statement-breakpoint
CREATE INDEX "stt_sessions_user_status_idx" ON "stt_sessions" USING btree ("user_uuid","status");