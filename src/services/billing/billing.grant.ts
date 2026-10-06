import { and, eq, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import {
  BillingPlans,
  BillingSubscriptions,
  BillingTransactions,
  BillingWallets,
} from "../../schema";

export type GrantPurchaseInput = {
  userUuid: string;
  transactionUuid: string;
  planUuid?: string | null;
  creditsFromTopup?: number;
  stripePaymentIntentId?: string | null;
  stripeSubscriptionId?: string | null;
  razorpayPaymentId?: string | null;
};

/**
 * Atomically claim a pending transaction, credit the wallet, and activate a
 * service subscription when applicable. Safe against double webhook/confirm.
 */
export const grantPurchaseFromTransaction = async (input: GrantPurchaseInput) => {
  const { userUuid, transactionUuid } = input;
  const [transaction] = await db
    .select()
    .from(BillingTransactions)
    .where(eq(BillingTransactions.transaction_uuid, transactionUuid))
    .limit(1);

  if (!transaction || transaction.status === "succeeded") return false;
  if (transaction.user_uuid !== userUuid) return false;

  const planUuid = input.planUuid ?? transaction.plan_uuid;
  const [plan] = planUuid
    ? await db.select().from(BillingPlans).where(eq(BillingPlans.plan_uuid, planUuid)).limit(1)
    : [];

  const metadataCredits = Number(
    (transaction.metadata as Record<string, unknown> | null)?.credits ?? 0,
  );
  const topupCredits = input.creditsFromTopup ?? metadataCredits;
  if (!plan && topupCredits <= 0) return false;

  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(BillingTransactions)
      .set({
        status: "succeeded",
        ...(input.stripePaymentIntentId !== undefined
          ? { stripe_payment_intent_id: input.stripePaymentIntentId }
          : {}),
        ...(input.razorpayPaymentId
          ? { razorpay_payment_id: input.razorpayPaymentId }
          : {}),
        metadata: {
          ...((transaction.metadata as Record<string, unknown>) || {}),
          checkoutCompleted: true,
        },
        updated_at: new Date(),
      })
      .where(
        and(
          eq(BillingTransactions.transaction_uuid, transactionUuid),
          eq(BillingTransactions.status, "pending"),
        ),
      )
      .returning({ transaction_uuid: BillingTransactions.transaction_uuid });

    if (!claimed) return;

    const credits = plan ? Number(plan.monthly_credits) : topupCredits;
    await tx
      .insert(BillingWallets)
      .values({ user_uuid: userUuid, balance_credits: credits.toFixed(6) })
      .onConflictDoUpdate({
        target: BillingWallets.user_uuid,
        set: {
          balance_credits: sql`${BillingWallets.balance_credits} + ${credits}`,
          updated_at: new Date(),
        },
      });

    if (plan?.plan_kind === "service") {
      await tx
        .update(BillingSubscriptions)
        .set({ status: "cancelled", updated_at: new Date() })
        .where(eq(BillingSubscriptions.user_uuid, userUuid));

      await tx.insert(BillingSubscriptions).values({
        user_uuid: userUuid,
        plan_uuid: plan.plan_uuid,
        status: "active",
        ...(input.stripeSubscriptionId
          ? { stripe_subscription_id: input.stripeSubscriptionId }
          : {}),
      });
    }
  });

  return true;
};

export const isStripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY?.trim());
export const isRazorpayConfigured = () =>
  Boolean(process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim());

export const appUrl = () =>
  (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");

export const minimumChargeMinor = (currency: string) =>
  currency.toUpperCase() === "INR" ? 5000 : 50;
