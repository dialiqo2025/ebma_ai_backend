CREATE TABLE "api_transaction_logs" (
	"log_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"user_uuid" uuid,
	"api_key_uuid" uuid,
	"method" varchar(12) NOT NULL,
	"path" varchar(1000) NOT NULL,
	"module" varchar(100) NOT NULL,
	"functionality" varchar(255) NOT NULL,
	"status" varchar(16) NOT NULL,
	"http_status" integer NOT NULL,
	"description" text NOT NULL,
	"error_code" varchar(150),
	"error_message" text,
	"request_metadata" jsonb,
	"response_metadata" jsonb,
	"ip_address" varchar(128),
	"user_agent" varchar(1000),
	"duration_ms" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_transaction_logs_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "gpu_service_logs" (
	"log_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid,
	"user_uuid" uuid,
	"api_key_uuid" uuid,
	"service" varchar(16) NOT NULL,
	"operation" varchar(100) NOT NULL,
	"endpoint" varchar(1000) NOT NULL,
	"status" varchar(16) NOT NULL,
	"upstream_status" integer,
	"description" text NOT NULL,
	"error_code" varchar(150),
	"error_message" text,
	"provider_reference" varchar(255),
	"request_metadata" jsonb,
	"response_metadata" jsonb,
	"artifact_file_name" varchar(255),
	"artifact_original_name" varchar(512),
	"artifact_content_type" varchar(255),
	"duration_ms" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observability_settings" (
	"setting_id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"retention_days" integer DEFAULT 7 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_transaction_logs" ADD CONSTRAINT "api_transaction_logs_user_uuid_users_user_uuid_fk" FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_transaction_logs" ADD CONSTRAINT "api_transaction_logs_api_key_uuid_api_keys_key_uuid_fk" FOREIGN KEY ("api_key_uuid") REFERENCES "public"."api_keys"("key_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gpu_service_logs" ADD CONSTRAINT "gpu_service_logs_user_uuid_users_user_uuid_fk" FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gpu_service_logs" ADD CONSTRAINT "gpu_service_logs_api_key_uuid_api_keys_key_uuid_fk" FOREIGN KEY ("api_key_uuid") REFERENCES "public"."api_keys"("key_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observability_settings" ADD CONSTRAINT "observability_settings_updated_by_users_user_uuid_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("user_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_transaction_logs_created_idx" ON "api_transaction_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_transaction_logs_status_created_idx" ON "api_transaction_logs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "api_transaction_logs_user_created_idx" ON "api_transaction_logs" USING btree ("user_uuid","created_at");--> statement-breakpoint
CREATE INDEX "api_transaction_logs_module_created_idx" ON "api_transaction_logs" USING btree ("module","created_at");--> statement-breakpoint
CREATE INDEX "gpu_service_logs_created_idx" ON "gpu_service_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "gpu_service_logs_service_status_idx" ON "gpu_service_logs" USING btree ("service","status","created_at");--> statement-breakpoint
CREATE INDEX "gpu_service_logs_user_created_idx" ON "gpu_service_logs" USING btree ("user_uuid","created_at");