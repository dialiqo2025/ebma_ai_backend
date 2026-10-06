ALTER TABLE "billing_transactions" ADD COLUMN "razorpay_order_id" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN "razorpay_payment_id" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN "razorpay_payment_link_id" varchar(255);--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD CONSTRAINT "billing_transactions_razorpay_order_id_unique" UNIQUE("razorpay_order_id");--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD CONSTRAINT "billing_transactions_razorpay_payment_id_unique" UNIQUE("razorpay_payment_id");--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD CONSTRAINT "billing_transactions_razorpay_payment_link_id_unique" UNIQUE("razorpay_payment_link_id");
