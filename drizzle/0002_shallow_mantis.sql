ALTER TABLE "users" RENAME COLUMN "mfa_code" TO "otp_code_hash";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "mfa_expires_at" TO "otp_expires_at";