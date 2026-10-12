ALTER TABLE "billing_transactions" ADD COLUMN IF NOT EXISTS "razorpay_order_id" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN IF NOT EXISTS "razorpay_payment_id" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN IF NOT EXISTS "razorpay_payment_link_id" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_transactions_razorpay_order_id_unique" ON "billing_transactions" ("razorpay_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_transactions_razorpay_payment_id_unique" ON "billing_transactions" ("razorpay_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_transactions_razorpay_payment_link_id_unique" ON "billing_transactions" ("razorpay_payment_link_id");
