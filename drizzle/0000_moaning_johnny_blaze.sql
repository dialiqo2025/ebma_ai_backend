CREATE TYPE "public"."user_role" AS ENUM('user', 'admin', 'superAdmin', 'tenant');--> statement-breakpoint
CREATE TABLE "users" (
	"user_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fullName" varchar(255) NOT NULL,
	"company_name" varchar(255),
	"email" varchar(255) NOT NULL,
	"password" varchar(255),
	"role" "user_role" DEFAULT 'user',
	"user_enabled" boolean DEFAULT true,
	"mfa_code" varchar(6),
	"mfa_expires_at" timestamp,
	"last_login" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
