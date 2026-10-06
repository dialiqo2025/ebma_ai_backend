ALTER TABLE "billing_plans" ADD COLUMN IF NOT EXISTS "is_public" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "enterprise_plan_requests" (
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
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "enterprise_plan_requests"
    ADD CONSTRAINT "enterprise_plan_requests_user_uuid_users_user_uuid_fk"
    FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "enterprise_plan_requests"
    ADD CONSTRAINT "enterprise_plan_requests_assigned_plan_uuid_billing_plans_plan_uuid_fk"
    FOREIGN KEY ("assigned_plan_uuid") REFERENCES "public"."billing_plans"("plan_uuid") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enterprise_request_user_idx" ON "enterprise_plan_requests" USING btree ("user_uuid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enterprise_request_status_idx" ON "enterprise_plan_requests" USING btree ("status");
