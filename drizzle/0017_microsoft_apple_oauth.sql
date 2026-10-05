ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "microsoft_id" varchar(255);-->statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "apple_id" varchar(255);-->statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_microsoft_id_unique" ON "users" ("microsoft_id");-->statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_apple_id_unique" ON "users" ("apple_id");
