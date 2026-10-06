import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import {
  BillingPlans,
  BillingRates,
  BillingSubscriptions,
  BillingTransactions,
  BillingWallets,
  EnterprisePlanRequests,
  Users,
} from "../../schema";
import { ensureDefaultPaygSubscription, ensureWallet } from "./billing.provider";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";

const defaultRates = { tts_characters: 0.03, stt_seconds: 1 / 60, llm_tokens: 1 } as const;

type PlanWriteInput = {
  code: string;
  name: string;
  description?: string;
  priceMinor: number;
  currency?: string;
  billingInterval?: string;
  planKind?: "service" | "wallet_topup";
  credits: number;
  active?: boolean;
  features?: { stt: boolean; tts: boolean; llm: boolean };
  benefits?: string[];
  ttsCreditsPer1000Chars?: number | null;
  sttCreditsPerMinute?: number | null;
  llmCreditsPer1000Tokens?: number | null;
  isDefault?: boolean;
  contactOnly?: boolean;
  /** false = private enterprise plan (hidden from Pricing, assignable by superadmin) */
  isPublic?: boolean;
};

const normalizeRate = (value: number | null | undefined) => {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return value.toFixed(6);
};

export const listPlans = async (includeInactive = true) => {
  const rows = await db
    .select()
    .from(BillingPlans)
    .where(includeInactive ? undefined : eq(BillingPlans.active, true))
    .orderBy(desc(BillingPlans.created_at));
  return GenResObj(Code.OK, true, "Plans fetched successfully", rows);
};

export const createPlan = async (input: PlanWriteInput) => {
  const code = input.code.trim().toLowerCase();
  const isDefault = Boolean(input.isDefault);
  const contactOnly = Boolean(input.contactOnly);
  const resolvedPublic = contactOnly
    ? true
    : input.isPublic === undefined
      ? true
      : Boolean(input.isPublic);

  if (isDefault) {
    await db
      .update(BillingPlans)
      .set({ is_default: false, updated_at: new Date() })
      .where(eq(BillingPlans.is_default, true));
  }

  const [plan] = await db
    .insert(BillingPlans)
    .values({
      code,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      price_minor: input.priceMinor,
      currency: (input.currency || "INR").toUpperCase(),
      billing_interval: input.billingInterval || "one_time",
      plan_kind:
        input.planKind || (code.startsWith("wallet_") ? "wallet_topup" : "service"),
      monthly_credits: input.credits.toFixed(6),
      tts_credits_per_1000_chars: normalizeRate(input.ttsCreditsPer1000Chars),
      stt_credits_per_minute: normalizeRate(input.sttCreditsPerMinute),
      llm_credits_per_1000_tokens: normalizeRate(input.llmCreditsPer1000Tokens),
      is_default: isDefault && !contactOnly,
      contact_only: contactOnly,
      is_public: resolvedPublic,
      features: { ...(input.features ?? { stt: true, tts: true }), llm: true },
      benefits: input.benefits ?? [],
      active: input.active ?? true,
    })
    .returning();
  return GenResObj(Code.CREATED, true, "Plan created successfully", plan);
};

export const updatePlan = async (
  planUuid: string,
  input: Partial<{
    name: string;
    description: string;
    priceMinor: number;
    currency: string;
    billingInterval: string;
    planKind: "service" | "wallet_topup";
    credits: number;
    active: boolean;
    features: { stt: boolean; tts: boolean; llm: boolean };
    benefits: string[];
    ttsCreditsPer1000Chars: number | null;
    sttCreditsPerMinute: number | null;
    llmCreditsPer1000Tokens: number | null;
    isDefault: boolean;
    contactOnly: boolean;
    isPublic: boolean;
  }>,
) => {
  if (input.isDefault === true) {
    await db
      .update(BillingPlans)
      .set({ is_default: false, updated_at: new Date() })
      .where(eq(BillingPlans.is_default, true));
  }

  const [plan] = await db
    .update(BillingPlans)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined
        ? { description: input.description.trim() }
        : {}),
      ...(input.priceMinor !== undefined ? { price_minor: input.priceMinor } : {}),
      ...(input.currency !== undefined
        ? { currency: input.currency.toUpperCase() }
        : {}),
      ...(input.billingInterval !== undefined
        ? { billing_interval: input.billingInterval }
        : {}),
      ...(input.planKind !== undefined ? { plan_kind: input.planKind } : {}),
      ...(input.credits !== undefined
        ? { monthly_credits: input.credits.toFixed(6) }
        : {}),
      ...(input.ttsCreditsPer1000Chars !== undefined
        ? { tts_credits_per_1000_chars: normalizeRate(input.ttsCreditsPer1000Chars) }
        : {}),
      ...(input.sttCreditsPerMinute !== undefined
        ? { stt_credits_per_minute: normalizeRate(input.sttCreditsPerMinute) }
        : {}),
      ...(input.llmCreditsPer1000Tokens !== undefined
        ? { llm_credits_per_1000_tokens: normalizeRate(input.llmCreditsPer1000Tokens) }
        : {}),
      ...(input.isDefault !== undefined
        ? { is_default: Boolean(input.isDefault) && input.contactOnly !== true }
        : {}),
      ...(input.contactOnly !== undefined
        ? {
            contact_only: Boolean(input.contactOnly),
            ...(input.contactOnly ? { is_default: false, is_public: true } : {}),
          }
        : {}),
      ...(input.isPublic !== undefined ? { is_public: Boolean(input.isPublic) } : {}),
      ...(input.features !== undefined
        ? { features: { ...input.features, llm: true } }
        : {}),
      ...(input.benefits !== undefined ? { benefits: input.benefits } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updated_at: new Date(),
    })
    .where(eq(BillingPlans.plan_uuid, planUuid))
    .returning();
  return plan
    ? GenResObj(Code.OK, true, "Plan updated successfully", plan)
    : GenResObj(Code.NOT_FOUND, false, "Plan not found");
};

export const listPublicPlans = async () => {
  const rows = await db
    .select()
    .from(BillingPlans)
    .where(and(eq(BillingPlans.active, true), eq(BillingPlans.is_public, true)))
    .orderBy(desc(BillingPlans.created_at));
  return GenResObj(Code.OK, true, "Available plans fetched successfully", rows);
};
export const deletePlan = async (planUuid: string) => {
  const [plan] = await db
    .delete(BillingPlans)
    .where(eq(BillingPlans.plan_uuid, planUuid))
    .returning({ planUuid: BillingPlans.plan_uuid });
  return plan
    ? GenResObj(Code.OK, true, "Plan deleted successfully")
    : GenResObj(Code.NOT_FOUND, false, "Plan not found");
};

export const listRates = async () => {
  const rows = await db.select().from(BillingRates);
  const values = {
    ...defaultRates,
    ...Object.fromEntries(rows.map((row) => [row.usage_type, Number(row.credits_per_unit)])),
  };
  return GenResObj(Code.OK, true, "Usage rates fetched successfully", values);
};

export const updateRates = async (input: Partial<typeof defaultRates>) => {
  for (const type of Object.keys(defaultRates) as Array<keyof typeof defaultRates>) {
    if (input[type] === undefined) continue;
    await db
      .insert(BillingRates)
      .values({
        usage_type: type,
        credits_per_unit: String(input[type]),
        updated_at: new Date(),
      })
      .onConflictDoUpdate({
        target: BillingRates.usage_type,
        set: { credits_per_unit: String(input[type]), updated_at: new Date() },
      });
  }
  return listRates();
};

export const listSubscriptions = async () =>
  GenResObj(
    Code.OK,
    true,
    "Subscriptions fetched successfully",
    await db.select().from(BillingSubscriptions).orderBy(desc(BillingSubscriptions.created_at)),
  );

export const listTransactions = async () =>
  GenResObj(
    Code.OK,
    true,
    "Transactions fetched successfully",
    await db.select().from(BillingTransactions).orderBy(desc(BillingTransactions.created_at)),
  );

export const listUserSubscriptions = async (userUuid: string) => {
  await ensureDefaultPaygSubscription(userUuid);
  return GenResObj(
    Code.OK,
    true,
    "Subscriptions fetched successfully",
    await db
      .select({ subscription: BillingSubscriptions, plan: BillingPlans })
      .from(BillingSubscriptions)
      .leftJoin(BillingPlans, eq(BillingSubscriptions.plan_uuid, BillingPlans.plan_uuid))
      .where(eq(BillingSubscriptions.user_uuid, userUuid))
      .orderBy(desc(BillingSubscriptions.created_at)),
  );
};

export const listUserTransactions = async (userUuid: string) =>
  GenResObj(
    Code.OK,
    true,
    "Transactions fetched successfully",
    await db
      .select({ transaction: BillingTransactions, plan: BillingPlans })
      .from(BillingTransactions)
      .leftJoin(BillingPlans, eq(BillingTransactions.plan_uuid, BillingPlans.plan_uuid))
      .where(eq(BillingTransactions.user_uuid, userUuid))
      .orderBy(desc(BillingTransactions.created_at)),
  );

export const getUserTransaction = async (userUuid: string, transactionUuid: string) => {
  const [row] = await db
    .select({ transaction: BillingTransactions, plan: BillingPlans })
    .from(BillingTransactions)
    .leftJoin(BillingPlans, eq(BillingTransactions.plan_uuid, BillingPlans.plan_uuid))
    .where(
      and(
        eq(BillingTransactions.user_uuid, userUuid),
        eq(BillingTransactions.transaction_uuid, transactionUuid),
      ),
    )
    .limit(1);
  return row
    ? GenResObj(Code.OK, true, "Transaction fetched successfully", row)
    : GenResObj(Code.NOT_FOUND, false, "Transaction not found");
};

export const getAdminUserWallet = async (userUuid: string) => {
  const [user] = await db
    .select({
      user_uuid: Users.user_uuid,
      email: Users.email,
      fullName: Users.fullName,
    })
    .from(Users)
    .where(eq(Users.user_uuid, userUuid))
    .limit(1);

  if (!user) return GenResObj(Code.NOT_FOUND, false, "User not found");

  const wallet = await ensureWallet(userUuid);
  const [subscription] = await db
    .select({ subscription: BillingSubscriptions, plan: BillingPlans })
    .from(BillingSubscriptions)
    .leftJoin(BillingPlans, eq(BillingSubscriptions.plan_uuid, BillingPlans.plan_uuid))
    .where(
      and(
        eq(BillingSubscriptions.user_uuid, userUuid),
        eq(BillingSubscriptions.status, "active"),
      ),
    )
    .orderBy(desc(BillingSubscriptions.created_at))
    .limit(1);

  return GenResObj(Code.OK, true, "Wallet fetched successfully", {
    user_uuid: user.user_uuid,
    email: user.email,
    fullName: user.fullName,
    balanceCredits: Number(wallet?.balance_credits ?? 0),
    planUuid: subscription?.plan?.plan_uuid ?? null,
    planName: subscription?.plan?.name ?? null,
    planCode: subscription?.plan?.code ?? null,
    subscriptionUuid: subscription?.subscription.subscription_uuid ?? null,
  });
};

export const assignUserPlan = async (userUuid: string, planUuid: string) => {
  const [user] = await db
    .select({ user_uuid: Users.user_uuid })
    .from(Users)
    .where(eq(Users.user_uuid, userUuid))
    .limit(1);
  if (!user) return GenResObj(Code.NOT_FOUND, false, "User not found");

  const [plan] = await db
    .select()
    .from(BillingPlans)
    .where(eq(BillingPlans.plan_uuid, planUuid))
    .limit(1);
  if (!plan || !plan.active) return GenResObj(Code.NOT_FOUND, false, "Plan not found");
  if (plan.contact_only) {
    return GenResObj(
      Code.BAD_REQUEST,
      false,
      "The public Custom / Contact-us card cannot be assigned. Create a private enterprise plan (isPublic: false) and assign that instead.",
    );
  }
  if (plan.plan_kind === "wallet_topup") {
    return GenResObj(Code.BAD_REQUEST, false, "Assign a service plan, not a wallet top-up");
  }

  await ensureWallet(userUuid);

  await db.transaction(async (tx) => {
    await tx
      .update(BillingSubscriptions)
      .set({ status: "cancelled", updated_at: new Date() })
      .where(
        and(
          eq(BillingSubscriptions.user_uuid, userUuid),
          eq(BillingSubscriptions.status, "active"),
        ),
      );
    await tx.insert(BillingSubscriptions).values({
      user_uuid: userUuid,
      plan_uuid: planUuid,
      status: "active",
      current_period_start: new Date(),
    });
  });

  return GenResObj(Code.OK, true, "Plan assigned successfully", {
    user_uuid: userUuid,
    plan_uuid: planUuid,
    planName: plan.name,
    planCode: plan.code,
  });
};

export const grantAdminUserCredits = async (input: {
  userUuid: string;
  credits: number;
  grantedByUuid: string;
  note?: string;
}) => {
  if (!Number.isFinite(input.credits) || input.credits <= 0) {
    return GenResObj(Code.BAD_REQUEST, false, "Credits must be a positive number");
  }

  const [user] = await db
    .select({ user_uuid: Users.user_uuid })
    .from(Users)
    .where(eq(Users.user_uuid, input.userUuid))
    .limit(1);

  if (!user) return GenResObj(Code.NOT_FOUND, false, "User not found");

  await ensureWallet(input.userUuid);

  await db.transaction(async (tx) => {
    await tx
      .update(BillingWallets)
      .set({
        balance_credits: sql`${BillingWallets.balance_credits} + ${input.credits}`,
        updated_at: new Date(),
      })
      .where(eq(BillingWallets.user_uuid, input.userUuid));

    await tx.insert(BillingTransactions).values({
      user_uuid: input.userUuid,
      amount_minor: 0,
      currency: "INR",
      payment_method: "admin_grant",
      status: "succeeded",
      metadata: {
        credits: input.credits,
        grantedBy: input.grantedByUuid,
        note: input.note?.trim() || null,
      },
    });
  });

  const [wallet] = await db
    .select()
    .from(BillingWallets)
    .where(eq(BillingWallets.user_uuid, input.userUuid))
    .limit(1);

  return GenResObj(Code.OK, true, "Credits added successfully", {
    user_uuid: input.userUuid,
    grantedCredits: input.credits,
    balanceCredits: Number(wallet?.balance_credits ?? 0),
  });
};

export const getUserCapabilities = async (userUuid: string) => {
  const plan = await ensureDefaultPaygSubscription(userUuid);
  const features = plan?.features ?? { stt: true, tts: true, llm: true };
  return GenResObj(Code.OK, true, "Capabilities fetched successfully", {
    plan: plan?.name ?? "Pay as you go",
    planCode: plan?.code ?? "payg",
    subscribed: Boolean(plan),
    capabilities: {
      stt: Boolean(features.stt),
      tts: Boolean(features.tts),
      llm: true,
      llmMode: "user",
    },
    rates: plan
      ? {
          ttsCreditsPer1000Chars: Number(plan.tts_credits_per_1000_chars ?? 30),
          sttCreditsPerMinute: Number(plan.stt_credits_per_minute ?? 1),
          llmCreditsPer1000Tokens: Number(plan.llm_credits_per_1000_tokens ?? 1),
          creditToInr: 1,
        }
      : {
          ttsCreditsPer1000Chars: 30,
          sttCreditsPerMinute: 1,
          llmCreditsPer1000Tokens: 1,
          creditToInr: 1,
        },
    paymentProviders: {
      stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY?.trim()),
      razorpayConfigured: Boolean(
        process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim(),
      ),
    },
  });
};

const ENTERPRISE_STATUSES = [
  "pending",
  "contacted",
  "approved",
  "rejected",
  "closed",
] as const;

export type EnterpriseRequestStatus = (typeof ENTERPRISE_STATUSES)[number];

export const createEnterprisePlanRequest = async (input: {
  userUuid: string;
  companyName: string;
  contactName: string;
  email: string;
  phone?: string;
  message?: string;
  estimatedMonthlyUsage?: string;
}) => {
  const companyName = input.companyName.trim();
  const contactName = input.contactName.trim();
  const email = input.email.trim().toLowerCase();
  if (!companyName || !contactName || !email) {
    return GenResObj(Code.BAD_REQUEST, false, "Company name, contact name, and email are required");
  }

  const [existing] = await db
    .select({ request_uuid: EnterprisePlanRequests.request_uuid })
    .from(EnterprisePlanRequests)
    .where(
      and(
        eq(EnterprisePlanRequests.user_uuid, input.userUuid),
        eq(EnterprisePlanRequests.status, "pending"),
      ),
    )
    .limit(1);

  if (existing) {
    return GenResObj(
      Code.BAD_REQUEST,
      false,
      "You already have a pending enterprise request. Our team will follow up soon.",
    );
  }

  const [row] = await db
    .insert(EnterprisePlanRequests)
    .values({
      user_uuid: input.userUuid,
      company_name: companyName,
      contact_name: contactName,
      email,
      phone: input.phone?.trim() || null,
      message: input.message?.trim() || null,
      estimated_monthly_usage: input.estimatedMonthlyUsage?.trim() || null,
      status: "pending",
    })
    .returning();

  return GenResObj(Code.CREATED, true, "Enterprise request submitted", row);
};

export const listMyEnterprisePlanRequests = async (userUuid: string) => {
  const rows = await db
    .select()
    .from(EnterprisePlanRequests)
    .where(eq(EnterprisePlanRequests.user_uuid, userUuid))
    .orderBy(desc(EnterprisePlanRequests.created_at));
  return GenResObj(Code.OK, true, "Enterprise requests fetched", rows);
};

export const listEnterprisePlanRequests = async (status?: string) => {
  const rows = await db
    .select({
      request: EnterprisePlanRequests,
      userEmail: Users.email,
      userFullName: Users.fullName,
    })
    .from(EnterprisePlanRequests)
    .leftJoin(Users, eq(Users.user_uuid, EnterprisePlanRequests.user_uuid))
    .where(
      status && ENTERPRISE_STATUSES.includes(status as EnterpriseRequestStatus)
        ? eq(EnterprisePlanRequests.status, status)
        : undefined,
    )
    .orderBy(desc(EnterprisePlanRequests.created_at));

  return GenResObj(
    Code.OK,
    true,
    "Enterprise requests fetched",
    rows.map((row) => ({
      ...row.request,
      user: { email: row.userEmail, fullName: row.userFullName },
    })),
  );
};

export const updateEnterprisePlanRequest = async (
  requestUuid: string,
  input: {
    status?: EnterpriseRequestStatus;
    adminNote?: string;
    assignedPlanUuid?: string | null;
  },
) => {
  if (input.status && !ENTERPRISE_STATUSES.includes(input.status)) {
    return GenResObj(Code.BAD_REQUEST, false, "Invalid status");
  }

  if (input.assignedPlanUuid) {
    const [plan] = await db
      .select()
      .from(BillingPlans)
      .where(eq(BillingPlans.plan_uuid, input.assignedPlanUuid))
      .limit(1);
    if (!plan || !plan.active) {
      return GenResObj(Code.NOT_FOUND, false, "Assigned plan not found");
    }
    if (plan.contact_only) {
      return GenResObj(
        Code.BAD_REQUEST,
        false,
        "Link a private enterprise service plan, not the public Contact-us card",
      );
    }
  }

  const [row] = await db
    .update(EnterprisePlanRequests)
    .set({
      ...(input.status ? { status: input.status } : {}),
      ...(input.adminNote !== undefined ? { admin_note: input.adminNote.trim() || null } : {}),
      ...(input.assignedPlanUuid !== undefined
        ? { assigned_plan_uuid: input.assignedPlanUuid }
        : {}),
      updated_at: new Date(),
    })
    .where(eq(EnterprisePlanRequests.request_uuid, requestUuid))
    .returning();

  if (!row) return GenResObj(Code.NOT_FOUND, false, "Enterprise request not found");

  // When approving with a plan, assign it to the user automatically.
  if (input.status === "approved" && input.assignedPlanUuid) {
    await assignUserPlan(row.user_uuid, input.assignedPlanUuid);
  }

  return GenResObj(Code.OK, true, "Enterprise request updated", row);
};
