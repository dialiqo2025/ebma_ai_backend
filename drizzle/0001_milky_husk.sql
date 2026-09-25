CREATE TYPE "public"."otp_purpose" AS ENUM('signup', 'login', 'password_reset');--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "fullName" TO "full_name";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "user_enabled" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "mfa_code" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "last_login" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "users" SET "email_verified" = true;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "otp_purpose" "otp_purpose";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "otp_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "otp_sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");
