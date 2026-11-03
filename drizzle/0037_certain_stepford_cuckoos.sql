ALTER TABLE "tts_generations" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "stt_transcriptions" ADD COLUMN "request_id" uuid;