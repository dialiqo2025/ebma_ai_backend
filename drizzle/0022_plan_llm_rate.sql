ALTER TABLE "billing_plans" ADD COLUMN IF NOT EXISTS "llm_credits_per_1000_tokens" numeric(18, 6);--> statement-breakpoint
UPDATE "billing_plans" SET "llm_credits_per_1000_tokens" = COALESCE("llm_credits_per_1000_tokens", '1') WHERE "code" = 'payg';
