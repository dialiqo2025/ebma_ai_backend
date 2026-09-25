CREATE TYPE "public"."tts_audio_format" AS ENUM('wav', 'mp3', 'ogg');--> statement-breakpoint
CREATE TYPE "public"."tts_generation_status" AS ENUM('queued', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tts_voice_mode" AS ENUM('default', 'clone');--> statement-breakpoint
CREATE TABLE "tts_generations" (
	"generation_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_uuid" uuid NOT NULL,
	"input_text" text NOT NULL,
	"language" varchar(32) DEFAULT 'auto' NOT NULL,
	"voice_mode" "tts_voice_mode" DEFAULT 'default' NOT NULL,
	"voice_id" varchar(255),
	"speed" real DEFAULT 1 NOT NULL,
	"pitch" real DEFAULT 1 NOT NULL,
	"audio_format" "tts_audio_format" DEFAULT 'wav' NOT NULL,
	"status" "tts_generation_status" DEFAULT 'queued' NOT NULL,
	"audio_file_name" varchar(255),
	"audio_mime_type" varchar(100),
	"audio_size_bytes" integer,
	"provider_request_id" varchar(255),
	"error_code" varchar(100),
	"error_message" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tts_generations" ADD CONSTRAINT "tts_generations_user_uuid_users_user_uuid_fk" FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE cascade ON UPDATE no action;