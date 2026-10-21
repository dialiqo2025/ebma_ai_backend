CREATE TABLE "daily_user_reports" (
	"report_date" date PRIMARY KEY NOT NULL,
	"window_start" timestamp NOT NULL,
	"window_end" timestamp NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"recipient" varchar(320) NOT NULL,
	"status" varchar(20) DEFAULT 'processing' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"provider_message_id" varchar(255),
	"error_message" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "daily_user_reports_status_idx" ON "daily_user_reports" USING btree ("status");