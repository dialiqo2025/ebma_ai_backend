ALTER TABLE "billing_plans" ADD COLUMN IF NOT EXISTS "tts_credits_per_1000_chars" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN IF NOT EXISTS "stt_credits_per_minute" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN IF NOT EXISTS "contact_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
INSERT INTO "billing_plans" (
  "code",
  "name",
  "description",
  "price_minor",
  "currency",
  "billing_interval",
  "plan_kind",
  "monthly_credits",
  "tts_credits_per_1000_chars",
  "stt_credits_per_minute",
  "is_default",
  "contact_only",
  "features",
  "benefits",
  "llm_mode",
  "active"
)
SELECT
  'payg',
  'Pay as you go',
  'Usage-based pricing. Top up your wallet and pay only for what you use. 1 credit = ₹1.',
  0,
  'INR',
  'one_time',
  'service',
  '0',
  '30',
  '1',
  true,
  false,
  '{"stt":true,"tts":true,"llm":true}'::jsonb,
  '["STT & TTS included","Wallet-based billing","1 credit = ₹1"]'::jsonb,
  'user',
  true
WHERE NOT EXISTS (SELECT 1 FROM "billing_plans" WHERE "code" = 'payg');--> statement-breakpoint
INSERT INTO "billing_plans" (
  "code",
  "name",
  "description",
  "price_minor",
  "currency",
  "billing_interval",
  "plan_kind",
  "monthly_credits",
  "tts_credits_per_1000_chars",
  "stt_credits_per_minute",
  "is_default",
  "contact_only",
  "features",
  "benefits",
  "llm_mode",
  "active"
)
SELECT
  'custom',
  'Custom',
  'Volume pricing, SLAs, and dedicated support for teams with higher usage.',
  0,
  'INR',
  'one_time',
  'service',
  '0',
  NULL,
  NULL,
  false,
  true,
  '{"stt":true,"tts":true,"llm":true}'::jsonb,
  '["Custom rates","Dedicated support","SLA options"]'::jsonb,
  'user',
  true
WHERE NOT EXISTS (SELECT 1 FROM "billing_plans" WHERE "code" = 'custom');--> statement-breakpoint
UPDATE "billing_plans"
SET
  "tts_credits_per_1000_chars" = COALESCE("tts_credits_per_1000_chars", '30'),
  "stt_credits_per_minute" = COALESCE("stt_credits_per_minute", '1'),
  "is_default" = true,
  "updated_at" = NOW()
WHERE "code" = 'payg';
