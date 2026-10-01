CREATE TABLE "llm_model_configs" (
	"model_uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(32) NOT NULL,
	"model_name" varchar(128) NOT NULL,
	"display_name" varchar(160) NOT NULL,
	"endpoint" varchar(500),
	"api_key" varchar(1000),
	"temperature" numeric(4, 2) DEFAULT '0.7' NOT NULL,
	"max_tokens" integer DEFAULT 1024 NOT NULL,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
