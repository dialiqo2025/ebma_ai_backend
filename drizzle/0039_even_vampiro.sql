CREATE TABLE "gpu_health_check_logs" (
	"check_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"context" varchar(32) NOT NULL,
	"endpoint" varchar(1000) NOT NULL,
	"method" varchar(8) NOT NULL,
	"http_status" integer,
	"duration_ms" integer NOT NULL,
	"response_body" text,
	"error_code" varchar(100),
	"error_message" text,
	"notification_status" varchar(24) DEFAULT 'not_requested' NOT NULL,
	"notification_recipient_count" integer DEFAULT 0 NOT NULL,
	"notification_error" text,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gpu_health_monitor_settings" (
	"setting_id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"check_interval_minutes" integer DEFAULT 30 NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"notifications_enabled" boolean DEFAULT true NOT NULL,
	"next_check_at" timestamp DEFAULT now() NOT NULL,
	"last_check_at" timestamp,
	"updated_by" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gpu_health_recipients" (
	"recipient_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gpu_health_monitor_settings" ADD CONSTRAINT "gpu_health_monitor_settings_updated_by_users_user_uuid_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("user_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gpu_health_recipients" ADD CONSTRAINT "gpu_health_recipients_created_by_users_user_uuid_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gpu_health_check_logs_checked_idx" ON "gpu_health_check_logs" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX "gpu_health_check_logs_status_checked_idx" ON "gpu_health_check_logs" USING btree ("status","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gpu_health_recipients_email_idx" ON "gpu_health_recipients" USING btree ("email");