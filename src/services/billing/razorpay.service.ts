import crypto from "node:crypto";
import Razorpay from "razorpay";
import { eq } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { BillingPlans, BillingTransactions, Users } from "../../schema";
import {
  appUrl,
  grantPurchaseFromTransaction,
  isRazorpayConfigured,
  minimumChargeMinor,
} from "./billing.grant";
import { razorpayCheckoutMethodFlags } from "./payment-providers.config";

const razorpay = () => {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) {
    throw new Error("Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

const currency = () => (process.env.RAZORPAY_CURRENCY || "INR").toUpperCase();

type PaymentLinkNotes = {
  userUuid: string;
  transactionUuid: string;
  planUuid?: string;
  planKind?: string;
  credits?: string;
};

const createPaymentLink = async (input: {
  userUuid: string;
  amountMinor: number;
  currencyCode: string;
  description: string;
  email?: string | null;
  notes: PaymentLinkNotes;
  cancelPath?: string;
}) => {
  const client = razorpay();
  // Return to Billing so the client can confirm + credit the wallet immediately.
  const billingSuccessBase = `${appUrl()}/platform/billing?checkout=success`;

  const link = await client.paymentLink.create({
    amount: input.amountMinor,
    currency: input.currencyCode,
    accept_partial: false,
    description: input.description,
    customer: input.email ? { email: input.email } : undefined,
    // Disable Razorpay's "confirm payment" emails; wallet is credited via callback/webhook.
    notify: { email: false, sms: false },
    reminder_enable: false,
    // Razorpay also appends razorpay_payment_link_id on redirect.
    callback_url: billingSuccessBase,
    callback_method: "get",
    notes: input.notes,
    options: {
      checkout: {
        method: razorpayCheckoutMethodFlags(),
      },
    },
  } as any);

  const linkId = String((link as any).id || "");
  const shortUrl = String((link as any).short_url || (link as any).url || "");
  if (!linkId || !shortUrl) throw new Error("Razorpay did not return a payment link");

  try {
    await client.paymentLink.edit(linkId, {
      callback_url: `${billingSuccessBase}&session_id=${encodeURIComponent(linkId)}`,
      callback_method: "get",
    } as any);
  } catch {
    // Webhook remains the source of truth if callback edit is unsupported.
  }

  return { linkId, url: shortUrl };
};

export const createCheckoutPaymentLink = async (userUuid: string, planUuid: string) => {
  if (!isRazorpayConfigured()) throw new Error("Razorpay is not configured");
  const [plan] = planUuid
    ? await db.select().from(BillingPlans).where(eq(BillingPlans.plan_uuid, planUuid)).limit(1)
    : [];
  if (!plan || !plan.active) throw new Error("Plan is not available");
  if (plan.contact_only) throw new Error("This plan requires contacting sales");
  if (plan.plan_kind === "wallet_topup") throw new Error("Wallet top-ups use the dynamic recharge flow");
  if (plan.price_minor <= 0) {
    throw new Error("This plan uses wallet top-up. Recharge your wallet instead of purchasing a plan.");
  }
  if (plan.currency.toUpperCase() !== "INR") {
    throw new Error("Razorpay checkout currently supports INR only");
  }
  if (plan.price_minor < minimumChargeMinor(plan.currency)) {
    throw new Error("Plan price is below the minimum charge (₹50).");
  }

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
      payment_method: "razorpay",
      status: "pending",
      metadata: { planKind: plan.plan_kind, paymentProvider: "razorpay" },
    })
    .returning();
  if (!transaction) throw new Error("Unable to create payment transaction");

  const { linkId, url } = await createPaymentLink({
    userUuid,
    amountMinor: plan.price_minor,
    currencyCode: plan.currency.toUpperCase(),
    description: plan.name,
    email: user?.email ?? null,
    notes: {
      userUuid,
      transactionUuid: transaction.transaction_uuid,
      planUuid: plan.plan_uuid,
      planKind: plan.plan_kind,
    },
  });

  await db
    .update(BillingTransactions)
    .set({ razorpay_payment_link_id: linkId, updated_at: new Date() })
    .where(eq(BillingTransactions.transaction_uuid, transaction.transaction_uuid));

  return { url, sessionId: linkId, provider: "razorpay" as const };
};

export const createWalletTopupPaymentLink = async (userUuid: string, amount: number) => {
  if (!isRazorpayConfigured()) throw new Error("Razorpay is not configured");
  const moneyCurrency = currency();
  if (moneyCurrency !== "INR") throw new Error("Razorpay wallet top-up currently supports INR only");
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    throw new Error("Enter a valid whole-number recharge amount");
  }
  const amountMinor = Math.round(amount * 100);
  if (amountMinor < minimumChargeMinor(moneyCurrency)) {
    throw new Error("Minimum recharge is ₹50");
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
      payment_method: "razorpay",
      status: "pending",
      metadata: { planKind: "wallet_topup", credits, paymentProvider: "razorpay" },
    })
    .returning();
  if (!transaction) throw new Error("Unable to create payment transaction");

  const { linkId, url } = await createPaymentLink({
    userUuid,
    amountMinor,
    currencyCode: moneyCurrency,
    description: `${credits} credit wallet recharge`,
    email: user?.email ?? null,
    notes: {
      userUuid,
      transactionUuid: transaction.transaction_uuid,
      planKind: "wallet_topup",
      credits: String(credits),
    },
  });

  await db
    .update(BillingTransactions)
    .set({ razorpay_payment_link_id: linkId, updated_at: new Date() })
    .where(eq(BillingTransactions.transaction_uuid, transaction.transaction_uuid));

  return {
    url,
    sessionId: linkId,
    amount,
    credits,
    currency: moneyCurrency,
    provider: "razorpay" as const,
  };
};

const notesFrom = (value: unknown): PaymentLinkNotes | null => {
  if (!value || typeof value !== "object") return null;
  const notes = value as Record<string, unknown>;
  const userUuid = typeof notes.userUuid === "string" ? notes.userUuid : null;
  const transactionUuid =
    typeof notes.transactionUuid === "string" ? notes.transactionUuid : null;
  if (!userUuid || !transactionUuid) return null;
  return {
    userUuid,
    transactionUuid,
    ...(typeof notes.planUuid === "string" ? { planUuid: notes.planUuid } : {}),
    ...(typeof notes.planKind === "string" ? { planKind: notes.planKind } : {}),
    ...(typeof notes.credits === "string" ? { credits: notes.credits } : {}),
  };
};

/** Normalize Razorpay `method` + optional extras for storage / UI. */
const instrumentFromRazorpayPayment = (payment: any) => {
  const method = String(payment?.method || "")
    .trim()
    .toLowerCase();
  if (!method) return { paymentMethod: null as string | null, detail: null as Record<string, unknown> | null };

  const detail: Record<string, unknown> = { provider: "razorpay", method };
  if (method === "card" && payment?.card) {
    const card = payment.card;
    if (card.network) detail.network = String(card.network);
    if (card.last4) detail.last4 = String(card.last4);
    if (card.type) detail.cardType = String(card.type);
  } else if (method === "upi") {
    if (payment?.vpa) detail.vpa = String(payment.vpa);
  } else if (method === "netbanking") {
    if (payment?.bank) detail.bank = String(payment.bank);
  } else if (method === "wallet" && payment?.wallet) {
    detail.wallet = String(payment.wallet);
  }

  return { paymentMethod: method.slice(0, 32), detail };
};

const fetchRazorpayInstrument = async (paymentId: string | null | undefined) => {
  if (!paymentId) {
    return { paymentMethod: null as string | null, detail: null as Record<string, unknown> | null };
  }
  try {
    const payment = await razorpay().payments.fetch(paymentId);
    return instrumentFromRazorpayPayment(payment);
  } catch {
    return { paymentMethod: null, detail: null };
  }
};

const grantFromNotes = async (
  notes: PaymentLinkNotes,
  paymentId?: string | null,
  paymentEntity?: any,
) => {
  const fromEntity = paymentEntity ? instrumentFromRazorpayPayment(paymentEntity) : null;
  const fetched =
    fromEntity?.paymentMethod
      ? fromEntity
      : await fetchRazorpayInstrument(paymentId);

  return grantPurchaseFromTransaction({
    userUuid: notes.userUuid,
    transactionUuid: notes.transactionUuid,
    planUuid: notes.planUuid ?? null,
    creditsFromTopup: notes.credits ? Number(notes.credits) : 0,
    razorpayPaymentId: paymentId ?? null,
    paymentMethod: fetched.paymentMethod,
    paymentMethodDetail: fetched.detail,
  });
};

export const confirmRazorpayCheckout = async (userUuid: string, paymentLinkId: string) => {
  const client = razorpay();
  const link = (await client.paymentLink.fetch(paymentLinkId)) as any;
  let notes = notesFrom(link?.notes);

  // Fallback: resolve pending transaction by payment link id if notes are missing/malformed.
  if (!notes) {
    const [tx] = await db
      .select()
      .from(BillingTransactions)
      .where(eq(BillingTransactions.razorpay_payment_link_id, paymentLinkId))
      .limit(1);
    if (tx && tx.user_uuid === userUuid) {
      const meta = (tx.metadata as Record<string, unknown> | null) || {};
      notes = {
        userUuid: tx.user_uuid,
        transactionUuid: tx.transaction_uuid,
        ...(typeof meta.planKind === "string" ? { planKind: meta.planKind } : {}),
        ...(meta.credits !== undefined ? { credits: String(meta.credits) } : {}),
      };
    }
  }

  if (!notes || notes.userUuid !== userUuid) {
    throw new Error("Checkout session does not belong to this user");
  }

  const status = String(link?.status || "");
  const paid = status === "paid" || Number(link?.amount_paid || 0) >= Number(link?.amount || 0);
  if (!paid) return { status: status || "created", credited: false };

  const payments = Array.isArray(link?.payments) ? link.payments : [];
  const paymentId =
    payments.find((p: any) => p?.status === "captured" || p?.status === "authorized")?.payment_id ||
    payments[0]?.payment_id ||
    null;

  if (paymentId) {
    await db
      .update(BillingTransactions)
      .set({ razorpay_payment_id: String(paymentId), updated_at: new Date() })
      .where(eq(BillingTransactions.transaction_uuid, notes.transactionUuid));
  }

  const creditedNow = await grantFromNotes(notes, paymentId ? String(paymentId) : null);
  // grant returns false if already credited earlier (webhook); treat paid links as credited.
  return { status: "paid", credited: Boolean(creditedNow) || true };
};

export const handleRazorpayWebhook = async (
  rawBody: Buffer,
  signature: string | undefined,
) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("Razorpay webhook is not configured. Set RAZORPAY_WEBHOOK_SECRET.");
  if (!signature) throw new Error("Missing Razorpay signature");

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Invalid Razorpay webhook signature");
  }

  const event = JSON.parse(rawBody.toString("utf8")) as {
    event?: string;
    payload?: any;
  };
  const type = String(event.event || "");

  if (type === "payment_link.paid" || type === "payment_link.partially_paid") {
    const entity = event.payload?.payment_link?.entity || event.payload?.payment_link;
    const paymentEntity = event.payload?.payment?.entity || null;
    const notes = notesFrom(entity?.notes);
    const paymentId =
      paymentEntity?.id ||
      entity?.payments?.[0]?.payment_id ||
      null;
    if (notes) {
      if (entity?.id) {
        await db
          .update(BillingTransactions)
          .set({
            razorpay_payment_link_id: String(entity.id),
            ...(paymentId ? { razorpay_payment_id: String(paymentId) } : {}),
            updated_at: new Date(),
          })
          .where(eq(BillingTransactions.transaction_uuid, notes.transactionUuid));
      }
      await grantFromNotes(notes, paymentId ? String(paymentId) : null, paymentEntity);
    }
  }

  if (type === "payment.captured") {
    const payment = event.payload?.payment?.entity;
    const notes = notesFrom(payment?.notes);
    if (notes) {
      await grantFromNotes(
        notes,
        payment?.id ? String(payment.id) : null,
        payment,
      );
    }
  }

  if (type === "payment_link.expired" || type === "payment_link.cancelled") {
    const entity = event.payload?.payment_link?.entity || event.payload?.payment_link;
    const notes = notesFrom(entity?.notes);
    if (notes) {
      await db
        .update(BillingTransactions)
        .set({ status: "cancelled", updated_at: new Date() })
        .where(eq(BillingTransactions.transaction_uuid, notes.transactionUuid));
    }
  }

  return type || "unknown";
};
