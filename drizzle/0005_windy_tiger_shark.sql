CREATE TYPE "public"."stt_transcription_status" AS ENUM('queued', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "stt_transcriptions" (
	"transcription_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_uuid" uuid NOT NULL,
	"provider_job_id" varchar(255) NOT NULL,
	"original_filename" varchar(512) NOT NULL,
	"content_type" varchar(255),
	"file_size_bytes" integer,
	"language" varchar(8) DEFAULT 'hi' NOT NULL,
	"diarize" boolean DEFAULT false NOT NULL,
	"speakers" integer,
	"status" "stt_transcription_status" DEFAULT 'queued' NOT NULL,
	"stage" varchar(64),
	"progress" real DEFAULT 0 NOT NULL,
	"audio_seconds" real,
	"transcript" text DEFAULT '' NOT NULL,
	"result_json" jsonb,
	"error_code" varchar(100),
	"error_message" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stt_transcriptions" ADD CONSTRAINT "stt_transcriptions_user_uuid_users_user_uuid_fk" FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stt_transcriptions_user_created_idx" ON "stt_transcriptions" USING btree ("user_uuid","created_at");--> statement-breakpoint
CREATE INDEX "stt_transcriptions_user_status_idx" ON "stt_transcriptions" USING btree ("user_uuid","status");--> statement-breakpoint
CREATE INDEX "stt_transcriptions_provider_job_idx" ON "stt_transcriptions" USING btree ("provider_job_id");