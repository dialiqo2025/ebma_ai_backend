ALTER TABLE "billing_usage_ledger" ADD COLUMN "request_id" uuid;--> statement-breakpoint
CREATE INDEX "billing_usage_request_idx" ON "billing_usage_ledger" USING btree ("request_id");