CREATE TABLE "projects" (
	"project_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_uuid" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tts_generations" ADD COLUMN "project_uuid" uuid;--> statement-breakpoint
ALTER TABLE "tts_generations" ADD COLUMN "api_key_uuid" uuid;--> statement-breakpoint
ALTER TABLE "stt_sessions" ADD COLUMN "project_uuid" uuid;--> statement-breakpoint
ALTER TABLE "stt_sessions" ADD COLUMN "api_key_uuid" uuid;--> statement-breakpoint
ALTER TABLE "stt_transcriptions" ADD COLUMN "project_uuid" uuid;--> statement-breakpoint
ALTER TABLE "stt_transcriptions" ADD COLUMN "api_key_uuid" uuid;--> statement-breakpoint
ALTER TABLE "billing_usage_ledger" ADD COLUMN "project_uuid" uuid;--> statement-breakpoint
ALTER TABLE "billing_usage_ledger" ADD COLUMN "api_key_uuid" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "project_uuid" uuid;--> statement-breakpoint
INSERT INTO "projects" ("user_uuid", "name", "description")
SELECT "user_uuid", 'Default project', 'Automatically created to keep existing API keys and usage working.'
FROM "users";
--> statement-breakpoint
UPDATE "api_keys" AS api_key
SET "project_uuid" = project.project_uuid
FROM "projects" AS project
WHERE project.user_uuid = api_key.user_uuid AND project.name = 'Default project';
--> statement-breakpoint
UPDATE "billing_usage_ledger" AS usage
SET "project_uuid" = project.project_uuid
FROM "projects" AS project
WHERE project.user_uuid = usage.user_uuid AND project.name = 'Default project';
--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "project_uuid" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_uuid_users_user_uuid_fk" FOREIGN KEY ("user_uuid") REFERENCES "public"."users"("user_uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_user_created_idx" ON "projects" USING btree ("user_uuid","created_at");--> statement-breakpoint
CREATE INDEX "projects_user_status_idx" ON "projects" USING btree ("user_uuid","status");--> statement-breakpoint
ALTER TABLE "tts_generations" ADD CONSTRAINT "tts_generations_project_uuid_projects_project_uuid_fk" FOREIGN KEY ("project_uuid") REFERENCES "public"."projects"("project_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tts_generations" ADD CONSTRAINT "tts_generations_api_key_uuid_api_keys_key_uuid_fk" FOREIGN KEY ("api_key_uuid") REFERENCES "public"."api_keys"("key_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stt_sessions" ADD CONSTRAINT "stt_sessions_project_uuid_projects_project_uuid_fk" FOREIGN KEY ("project_uuid") REFERENCES "public"."projects"("project_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stt_sessions" ADD CONSTRAINT "stt_sessions_api_key_uuid_api_keys_key_uuid_fk" FOREIGN KEY ("api_key_uuid") REFERENCES "public"."api_keys"("key_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stt_transcriptions" ADD CONSTRAINT "stt_transcriptions_project_uuid_projects_project_uuid_fk" FOREIGN KEY ("project_uuid") REFERENCES "public"."projects"("project_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stt_transcriptions" ADD CONSTRAINT "stt_transcriptions_api_key_uuid_api_keys_key_uuid_fk" FOREIGN KEY ("api_key_uuid") REFERENCES "public"."api_keys"("key_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_usage_ledger" ADD CONSTRAINT "billing_usage_ledger_project_uuid_projects_project_uuid_fk" FOREIGN KEY ("project_uuid") REFERENCES "public"."projects"("project_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_usage_ledger" ADD CONSTRAINT "billing_usage_ledger_api_key_uuid_api_keys_key_uuid_fk" FOREIGN KEY ("api_key_uuid") REFERENCES "public"."api_keys"("key_uuid") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_uuid_projects_project_uuid_fk" FOREIGN KEY ("project_uuid") REFERENCES "public"."projects"("project_uuid") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_usage_project_created_idx" ON "billing_usage_ledger" USING btree ("project_uuid","created_at");--> statement-breakpoint
CREATE INDEX "api_keys_project_idx" ON "api_keys" USING btree ("project_uuid");