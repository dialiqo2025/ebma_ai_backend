ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL;-->statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_id" varchar(255);-->statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_provider" varchar(32) DEFAULT 'email' NOT NULL;-->statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_google_id_unique" ON "users" ("google_id");
