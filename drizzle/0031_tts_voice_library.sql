CREATE TABLE "tts_voices" (
	"voice_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_uuid" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"language" varchar(32) DEFAULT 'en' NOT NULL,
	"description" varchar(280),
	"reference_audio_file_name" varchar(255) NOT NULL,
	"original_file_name" varchar(255),
	"audio_mime_type" varchar(100),
	"audio_size_bytes" integer,
	"reference_text" text,
	"consent_confirmed_at" timestamp NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tts_voices" ADD CONSTRAINT "tts_voices_user_uuid_users_user_uuid_fk" FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tts_voices_user_created_idx" ON "tts_voices" USING btree ("user_uuid","created_at");