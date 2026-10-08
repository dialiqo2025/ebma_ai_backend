import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import {
  BillingPlans,
  BillingSubscriptions,
  BillingTransactions,
  Users,
} from "../../schema";
import {
  appUrl,
  grantPurchaseFromTransaction,
  minimumChargeMinor,
} from "./billing.grant";
import { stripePaymentMethodTypes } from "./payment-providers.config";

const stripe = () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY.");
  return new Stripe(key);
};

const currency = () => (process.env.STRIPE_CURRENCY || "INR").toUpperCase();

export const createCheckoutSession = async (userUuid: string, planUuid: string) => {
  const [plan] = planUuid
    ? await db.select().from(BillingPlans).where(eq(BillingPlans.plan_uuid, planUuid)).limit(1)
    : [];
  if (!plan || !plan.active) throw new Error("Plan is not available");
  if ((plan as { contact_only?: boolean }).contact_only) {
    throw new Error("This plan requires contacting sales");
  }
  if (plan.plan_kind === "wallet_topup") throw new Error("Wallet top-ups use the dynamic recharge flow");
  if (plan.price_minor <= 0) {
    throw new Error("This plan uses wallet top-up. Recharge your wallet instead of purchasing a plan.");
  }
  if (plan.price_minor < minimumChargeMinor(plan.currency)) {
    throw new Error(
      `Plan price is below Stripe's minimum charge. Set it to at least ${plan.currency.toUpperCase() === "INR" ? "₹50" : "0.50"}.`,
    );
  }
  const client = stripe();
  const [user] = await db
    .select({ email: Users.email })
    .from(Users)
    .where(eq(Users.user_uuid, userUuid))
    .limit(1);
  const [transaction] = await db
    .insert(BillingTransactions)
    .values({
      user_uuid: userUuid,
      plan_uuid: plan.plan_uuid,
      amount_minor: plan.price_minor,
      currency: plan.currency,
      payment_method: "stripe",
      status: "pending",
      metadata: { planKind: plan.plan_kind, paymentProvider: "stripe" },
    })
    .returning();
  if (!transaction) throw new Error("Unable to create payment transaction");
  const recurring = plan.billing_interval === "monthly" || plan.billing_interval === "yearly";
  const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = plan.stripe_price_id
    ? { price: plan.stripe_price_id, quantity: 1 }
    : {
        price_data: {
          currency: plan.currency.toLowerCase(),
          product_data: {
            name: plan.name,
            ...(plan.description ? { description: plan.description } : {}),
          },
          unit_amount: plan.price_minor,
          ...(recurring
            ? {
                recurring: {
                  interval: plan.billing_interval === "yearly" ? ("year" as const) : ("month" as const),
                },
              }
            : {}),
        },
        quantity: 1,
      };
  const params = {
    mode: recurring ? "subscription" : "payment",
    managed_payments: { enabled: false },
    payment_method_types: stripePaymentMethodTypes() as Stripe.Checkout.SessionCreateParams.PaymentMethodType[],
    customer_email: user?.email || undefined,
    line_items: [lineItem],
    success_url: `${appUrl()}/platform/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl()}/platform/billing?checkout=cancelled`,
    metadata: {
      userUuid,
      planUuid: plan.plan_uuid,
      transactionUuid: transaction.transaction_uuid,
    },
    ...(recurring
      ? {
          subscription_data: {
            metadata: {
              userUuid,
              planUuid: plan.plan_uuid,
              transactionUuid: transaction.transaction_uuid,
            },
          },
        }
      : {}),
  } as Stripe.Checkout.SessionCreateParams;
  const session = await client.checkout.sessions.create(params);
  await db
    .update(BillingTransactions)
    .set({ stripe_checkout_session_id: session.id, updated_at: new Date() })
    .where(eq(BillingTransactions.transaction_uuid, transaction.transaction_uuid));
  return { url: session.url, sessionId: session.id, provider: "stripe" as const };
};

export const createWalletTopupCheckout = async (userUuid: string, amount: number) => {
  const moneyCurrency = currency();
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    throw new Error("Enter a valid whole-number recharge amount");
  }
  const amountMinor = Math.round(amount * 100);
  if (amountMinor < minimumChargeMinor(moneyCurrency)) {
    throw new Error(`Minimum recharge is ${moneyCurrency === "INR" ? "₹50" : "0.50"}`);
  }
  const credits = Math.floor(amount);
  if (credits < 1) throw new Error("Recharge amount must add at least 1 credit");
  const [user] = await db
    .select({ email: Users.email })
    .from(Users)
    .where(eq(Users.user_uuid, userUuid))
    .limit(1);
  const [transaction] = await db
    .insert(BillingTransactions)
    .values({
      user_uuid: userUuid,
      amount_minor: amountMinor,
      currency: moneyCurrency,
      payment_method: "stripe",
      status: "pending",
      metadata: { planKind: "wallet_topup", credits, paymentProvider: "stripe" },
    })
    .returning();
  if (!transaction) throw new Error("Unable to create payment transaction");
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    managed_payments: { enabled: false },
    payment_method_types: stripePaymentMethodTypes() as Stripe.Checkout.SessionCreateParams.PaymentMethodType[],
    customer_email: user?.email || undefined,
    line_items: [
      {
        price_data: {
          currency: moneyCurrency.toLowerCase(),
          product_data: { name: `${credits} credit wallet recharge` },
          unit_amount: amountMinor,
        },
        quantity: 1,
      },
    ],
    success_url: `${appUrl()}/platform/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl()}/platform/billing?checkout=cancelled`,
    metadata: {
      userUuid,
      transactionUuid: transaction.transaction_uuid,
      planKind: "wallet_topup",
      credits: String(credits),
    },
  } as Stripe.Checkout.SessionCreateParams);
  await db
    .update(BillingTransactions)
    .set({ stripe_checkout_session_id: session.id, updated_at: new Date() })
    .where(eq(BillingTransactions.transaction_uuid, transaction.transaction_uuid));
  return {
    url: session.url,
    sessionId: session.id,
    amount,
    credits,
    currency: moneyCurrency,
    provider: "stripe" as const,
  };
};

const instrumentFromStripeSession = async (session: Stripe.Checkout.Session) => {
  const detail: Record<string, unknown> = { provider: "stripe" };
  let paymentMethod: string | null = null;

  try {
    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent && typeof session.payment_intent === "object"
          ? session.payment_intent.id
          : null;

    if (paymentIntentId) {
      const pi = await stripe().paymentIntents.retrieve(paymentIntentId, {
        expand: ["payment_method", "latest_charge"],
      });
      const pm =
        typeof pi.payment_method === "object" && pi.payment_method
          ? pi.payment_method
          : null;
      const type = pm?.type || pi.payment_method_types?.[0] || null;
      if (type) {
        paymentMethod = String(type).slice(0, 32);
        detail.method = paymentMethod;
      }
      if (pm?.card) {
        if (pm.card.brand) detail.network = pm.card.brand;
        if (pm.card.last4) detail.last4 = pm.card.last4;
      }
      const charge =
        typeof pi.latest_charge === "object" && pi.latest_charge
          ? pi.latest_charge
          : null;
      const pmd = charge?.payment_method_details;
      if (pmd?.type && !paymentMethod) {
        paymentMethod = String(pmd.type).slice(0, 32);
        detail.method = paymentMethod;
      }
      // UPI isn't in the installed Stripe SDK types yet; read it defensively.
      const upiVpa =
        pmd?.type === "upi"
          ? (pmd as { upi?: { vpa?: string | null } }).upi?.vpa
          : undefined;
      if (upiVpa) detail.vpa = upiVpa;
      if (pmd?.type === "card" && pmd.card) {
        if (pmd.card.brand) detail.network = pmd.card.brand;
        if (pmd.card.last4) detail.last4 = pmd.card.last4;
      }
    } else if (session.payment_method_types?.[0]) {
      paymentMethod = String(session.payment_method_types[0]).slice(0, 32);
      detail.method = paymentMethod;
    }
  } catch {
    // Fall back to gateway label if Stripe expand fails.
  }

  return {
    paymentMethod: paymentMethod || "stripe",
    detail: paymentMethod ? detail : { provider: "stripe" },
  };
};

const grantFromStripeSession = async (session: Stripe.Checkout.Session) => {
  const { userUuid, planUuid, transactionUuid } = session.metadata || {};
  if (!userUuid || !transactionUuid) return;
  const instrument = await instrumentFromStripeSession(session);
  await grantPurchaseFromTransaction({
    userUuid,
    transactionUuid,
    planUuid: planUuid || null,
    creditsFromTopup: Number(session.metadata?.credits || 0),
    stripePaymentIntentId:
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent && typeof session.payment_intent === "object"
          ? session.payment_intent.id
          : null,
    stripeSubscriptionId:
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription && typeof session.subscription === "object"
          ? session.subscription.id
          : null,
    paymentMethod: instrument.paymentMethod,
    paymentMethodDetail: instrument.detail,
  });
};

export const confirmCheckoutSession = async (userUuid: string, sessionId: string) => {
  const session = await stripe().checkout.sessions.retrieve(sessionId, {
    expand: ["payment_intent", "payment_intent.payment_method"],
  });
  if (session.metadata?.userUuid !== userUuid) {
    throw new Error("Checkout session does not belong to this user");
  }
  if (session.payment_status !== "paid") {
    return { status: session.payment_status, credited: false };
  }
  await grantFromStripeSession(session);
  return { status: session.payment_status, credited: true };
};

export const cancelUserSubscription = async (userUuid: string, subscriptionUuid: string) => {
  const [row] = await db
    .select()
    .from(BillingSubscriptions)
    .where(eq(BillingSubscriptions.subscription_uuid, subscriptionUuid))
    .limit(1);
  if (!row || row.user_uuid !== userUuid) throw new Error("Subscription not found");
  if (row.stripe_subscription_id) {
    await stripe().subscriptions.update(row.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
    await db
      .update(BillingSubscriptions)
      .set({ status: "cancelling", updated_at: new Date() })
      .where(eq(BillingSubscriptions.subscription_uuid, subscriptionUuid));
    return {
      subscriptionUuid,
      status: "cancelling",
      accessUntil: row.current_period_end,
    };
  }

  await db
    .update(BillingSubscriptions)
    .set({ status: "cancelled", updated_at: new Date() })
    .where(eq(BillingSubscriptions.subscription_uuid, subscriptionUuid));
  return {
    subscriptionUuid,
    status: "cancelled",
    accessUntil: row.current_period_end,
  };
};

export const handleStripeWebhook = async (
  rawBody: Buffer,
  signature: string | undefined,
) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("Stripe webhook is not configured. Set STRIPE_WEBHOOK_SECRET.");
  const event = stripe().webhooks.constructEvent(rawBody, signature || "", secret);
  if (event.type === "checkout.session.completed") {
    await grantFromStripeSession(event.data.object as Stripe.Checkout.Session);
  }
  if (event.type === "checkout.session.expired") {
    const session = event.data.object as Stripe.Checkout.Session;
    const transactionUuid = session.metadata?.transactionUuid;
    if (transactionUuid) {
      await db
        .update(BillingTransactions)
        .set({ status: "cancelled", updated_at: new Date() })
        .where(eq(BillingTransactions.transaction_uuid, transactionUuid));
    }
  }
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    await db
      .update(BillingSubscriptions)
      .set({ status: "cancelled", updated_at: new Date() })
      .where(eq(BillingSubscriptions.stripe_subscription_id, subscription.id));
  }
  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as Stripe.Subscription;
    await db
      .update(BillingSubscriptions)
      .set({
        status: subscription.status === "active" ? "active" : subscription.status,
        current_period_start: new Date(
          subscription.items.data[0]?.current_period_start
            ? subscription.items.data[0].current_period_start * 1000
            : Date.now(),
        ),
        current_period_end: new Date(
          subscription.items.data[0]?.current_period_end
            ? subscription.items.data[0].current_period_end * 1000
            : Date.now(),
        ),
        updated_at: new Date(),
      })
      .where(eq(BillingSubscriptions.stripe_subscription_id, subscription.id));
  }
  return event.type;
};
