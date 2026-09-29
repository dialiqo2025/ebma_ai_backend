CREATE TYPE "public"."billing_usage_type" AS ENUM('tts_characters', 'stt_seconds', 'llm_tokens');--> statement-breakpoint
CREATE TABLE "billing_plans" (
	"plan_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"monthly_credits" numeric(18, 6) DEFAULT '0' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_plans_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "billing_usage_ledger" (
	"usage_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_uuid" uuid NOT NULL,
	"usage_type" "billing_usage_type" NOT NULL,
	"quantity" numeric(18, 6) NOT NULL,
	"unit_price_credits" numeric(18, 6) NOT NULL,
	"charged_credits" numeric(18, 6) NOT NULL,
	"provider_reference" varchar(255),
	"idempotency_key" varchar(255) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_usage_ledger_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "billing_wallets" (
	"wallet_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_uuid" uuid NOT NULL,
	"balance_credits" numeric(18, 6) DEFAULT '0' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_wallets_user_uuid_unique" UNIQUE("user_uuid")
);
--> statement-breakpoint
ALTER TABLE "billing_usage_ledger" ADD CONSTRAINT "billing_usage_ledger_user_uuid_users_user_uuid_fk" FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_wallets" ADD CONSTRAINT "billing_wallets_user_uuid_users_user_uuid_fk" FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_usage_user_created_idx" ON "billing_usage_ledger" USING btree ("user_uuid","created_at");