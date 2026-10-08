CREATE TABLE "enterprise_plan_requests" (
	"request_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_uuid" uuid NOT NULL,
	"company_name" varchar(255) NOT NULL,
	"contact_name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(64),
	"message" varchar(2000),
	"estimated_monthly_usage" varchar(500),
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"assigned_plan_uuid" uuid,
	"admin_note" varchar(1000),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tts_generations" ADD COLUMN "reference_audio_file_name" varchar(255);--> statement-breakpoint
ALTER TABLE "tts_generations" ADD COLUMN "reference_text" text;--> statement-breakpoint
ALTER TABLE "tts_generations" ADD COLUMN "emotion" varchar(32);--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN "tts_credits_per_1000_chars" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN "stt_credits_per_minute" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN "llm_credits_per_1000_tokens" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN "contact_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_plans" ADD COLUMN "is_public" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN "razorpay_order_id" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN "razorpay_payment_id" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN "razorpay_payment_link_id" varchar(255);--> statement-breakpoint
ALTER TABLE "enterprise_plan_requests" ADD CONSTRAINT "enterprise_plan_requests_user_uuid_users_user_uuid_fk" FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_plan_requests" ADD CONSTRAINT "enterprise_plan_requests_assigned_plan_uuid_billing_plans_plan_uuid_fk" FOREIGN KEY ("assigned_plan_uuid") REFERENCES "public"."billing_plans"("plan_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enterprise_request_user_idx" ON "enterprise_plan_requests" USING btree ("user_uuid");--> statement-breakpoint
CREATE INDEX "enterprise_request_status_idx" ON "enterprise_plan_requests" USING btree ("status");--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD CONSTRAINT "billing_transactions_razorpay_order_id_unique" UNIQUE("razorpay_order_id");--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD CONSTRAINT "billing_transactions_razorpay_payment_id_unique" UNIQUE("razorpay_payment_id");--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD CONSTRAINT "billing_transactions_razorpay_payment_link_id_unique" UNIQUE("razorpay_payment_link_id");