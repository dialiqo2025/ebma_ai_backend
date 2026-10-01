CREATE TABLE "billing_rates" (
	"rate_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usage_type" "billing_usage_type" NOT NULL,
	"credits_per_unit" numeric(18, 6) NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_rates_usage_type_unique" UNIQUE("usage_type")
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"subscription_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_uuid" uuid NOT NULL,
	"plan_uuid" uuid,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"stripe_subscription_id" varchar(255),
	"current_period_start" timestamp,
	"current_period_end" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "billing_transactions" (
	"transaction_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_uuid" uuid NOT NULL,
	"plan_uuid" uuid,
	"amount_minor" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"stripe_checkout_session_id" varchar(255),
	"stripe_payment_intent_id" varchar(255),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_transactions_stripe_checkout_session_id_unique" UNIQUE("stripe_checkout_session_id"),
	CONSTRAINT "billing_transactions_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id")
);
--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN "description" varchar(500);--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN "price_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN "currency" varchar(3) DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN "billing_interval" varchar(20) DEFAULT 'one_time' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN "stripe_price_id" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_uuid_users_user_uuid_fk" FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_plan_uuid_billing_plans_plan_uuid_fk" FOREIGN KEY ("plan_uuid") REFERENCES "public"."billing_plans"("plan_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD CONSTRAINT "billing_transactions_user_uuid_users_user_uuid_fk" FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD CONSTRAINT "billing_transactions_plan_uuid_billing_plans_plan_uuid_fk" FOREIGN KEY ("plan_uuid") REFERENCES "public"."billing_plans"("plan_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_subscription_user_idx" ON "billing_subscriptions" USING btree ("user_uuid");--> statement-breakpoint
CREATE INDEX "billing_transaction_user_idx" ON "billing_transactions" USING btree ("user_uuid");