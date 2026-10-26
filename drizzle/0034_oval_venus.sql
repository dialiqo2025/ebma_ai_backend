ALTER TABLE "billing_plans" ADD COLUMN IF NOT EXISTS "tts_rate_credits" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN IF NOT EXISTS "tts_rate_chars" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN IF NOT EXISTS "stt_rate_credits" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN IF NOT EXISTS "stt_rate_minutes" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN IF NOT EXISTS "llm_rate_credits" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN IF NOT EXISTS "llm_rate_tokens" numeric(18, 6);--> statement-breakpoint

-- Preserve existing plan pricing when migrating from the legacy normalized
-- rate columns.
UPDATE "billing_plans"
SET
  "tts_rate_credits" = COALESCE("tts_rate_credits", "tts_credits_per_1000_chars", '30'),
  "tts_rate_chars" = COALESCE("tts_rate_chars", '1000'),
  "stt_rate_credits" = COALESCE("stt_rate_credits", "stt_credits_per_minute", '1'),
  "stt_rate_minutes" = COALESCE("stt_rate_minutes", '1'),
  "llm_rate_credits" = COALESCE("llm_rate_credits", "llm_credits_per_1000_tokens", '1'),
  "llm_rate_tokens" = COALESCE("llm_rate_tokens", '1000'),
  "updated_at" = NOW()
WHERE
  "tts_rate_credits" IS NULL
  OR "tts_rate_chars" IS NULL
  OR "stt_rate_credits" IS NULL
  OR "stt_rate_minutes" IS NULL
  OR "llm_rate_credits" IS NULL
  OR "llm_rate_tokens" IS NULL;
