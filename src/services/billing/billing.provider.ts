import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import {
  BillingPlans,
  BillingRates,
  BillingSubscriptions,
  BillingUsageLedger,
  BillingWallets,
} from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";

export const BILLING_PRICES = {
  tts_characters: Number(process.env.BILLING_TTS_CREDITS_PER_CHARACTER ?? 0.03),
  stt_seconds: Number(process.env.BILLING_STT_CREDITS_PER_SECOND ?? 1 / 60),
  llm_tokens: Number(process.env.BILLING_LLM_CREDITS_PER_TOKEN ?? 1),
} as const;

/** Default PAYG rates: ₹30 / 1000 TTS chars, ₹1 / STT minute. 1 credit = ₹1. */
export const DEFAULT_PLAN_RATES = {
  ttsCreditsPer1000Chars: 30,
  sttCreditsPerMinute: 1,
} as const;

const currentGlobalPrices = async () => {
  const rows = await db.select().from(BillingRates);
  return {
    ...BILLING_PRICES,
    ...Object.fromEntries(rows.map((row) => [row.usage_type, Number(row.credits_per_unit)])),
  } as typeof BILLING_PRICES;
};

const initialCredits = () => {
  const value = Number(process.env.BILLING_INITIAL_CREDITS ?? 1000);
  return Number.isFinite(value) && value >= 0 ? value : 1000;
};

const formatCredits = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

export const ensureWallet = async (userUuid: string) => {
  const [wallet] = await db
    .insert(BillingWallets)
    .values({ user_uuid: userUuid, balance_credits: initialCredits().toFixed(6) })
    .onConflictDoNothing({ target: BillingWallets.user_uuid })
    .returning();
  if (wallet) return wallet;
  const [existing] = await db
    .select()
    .from(BillingWallets)
    .where(eq(BillingWallets.user_uuid, userUuid))
    .limit(1);
  return existing;
};

export const getDefaultPaygPlan = async () => {
  const [byFlag] = await db
    .select()
    .from(BillingPlans)
    .where(and(eq(BillingPlans.is_default, true), eq(BillingPlans.active, true)))
    .orderBy(desc(BillingPlans.created_at))
    .limit(1);
  if (byFlag) return byFlag;
  const [byCode] = await db
    .select()
    .from(BillingPlans)
    .where(and(eq(BillingPlans.code, "payg"), eq(BillingPlans.active, true)))
    .limit(1);
  return byCode ?? null;
};

/** Assign default PAYG subscription if the user has none. Idempotent. */
export const ensureDefaultPaygSubscription = async (userUuid: string) => {
  await ensureWallet(userUuid);

  const [active] = await db
    .select({
      subscription_uuid: BillingSubscriptions.subscription_uuid,
      plan: BillingPlans,
    })
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

  if (active?.plan) return active.plan;

  const payg = await getDefaultPaygPlan();
  if (!payg) return null;

  await db.insert(BillingSubscriptions).values({
    user_uuid: userUuid,
    plan_uuid: payg.plan_uuid,
    status: "active",
    current_period_start: new Date(),
  });

  return payg;
};

const resolvePlanUnitPrices = async (userUuid: string) => {
  const plan = await ensureDefaultPaygSubscription(userUuid);
  const global = await currentGlobalPrices();

  const ttsPer1000 = Number(
    plan?.tts_credits_per_1000_chars ?? DEFAULT_PLAN_RATES.ttsCreditsPer1000Chars,
  );
  const sttPerMinute = Number(
    plan?.stt_credits_per_minute ?? DEFAULT_PLAN_RATES.sttCreditsPerMinute,
  );
  const llmPer1000 = Number(plan?.llm_credits_per_1000_tokens ?? global.llm_tokens * 1000);

  return {
    plan,
    ttsCreditsPer1000Chars: Number.isFinite(ttsPer1000)
      ? ttsPer1000
      : DEFAULT_PLAN_RATES.ttsCreditsPer1000Chars,
    sttCreditsPerMinute: Number.isFinite(sttPerMinute)
      ? sttPerMinute
      : DEFAULT_PLAN_RATES.sttCreditsPerMinute,
    /** Effective credits per character / second / token for ledger unit price. */
    unitPrices: {
      tts_characters:
        (Number.isFinite(ttsPer1000)
          ? ttsPer1000
          : DEFAULT_PLAN_RATES.ttsCreditsPer1000Chars) / 1000,
      stt_seconds:
        (Number.isFinite(sttPerMinute)
          ? sttPerMinute
          : DEFAULT_PLAN_RATES.sttCreditsPerMinute) / 60,
      llm_tokens: Number.isFinite(llmPer1000) ? llmPer1000 / 1000 : global.llm_tokens,
    },
  };
};

export const recordUsage = async (input: {
  userUuid: string;
  type: keyof typeof BILLING_PRICES;
  quantity: number;
  idempotencyKey: string;
  providerReference?: string;
  metadata?: Record<string, unknown>;
}) => {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return;
  try {
    const { unitPrices, plan } = await resolvePlanUnitPrices(input.userUuid);
    const unitPrice = unitPrices[input.type];
    const charged = input.quantity * unitPrice;
    await ensureWallet(input.userUuid);
    const [inserted] = await db
      .insert(BillingUsageLedger)
      .values({
        user_uuid: input.userUuid,
        usage_type: input.type,
        quantity: input.quantity.toFixed(6),
        unit_price_credits: unitPrice.toFixed(6),
        charged_credits: charged.toFixed(6),
        idempotency_key: input.idempotencyKey,
        provider_reference: input.providerReference,
        metadata: {
          ...input.metadata,
          planUuid: plan?.plan_uuid ?? null,
          planCode: plan?.code ?? null,
        },
      })
      .onConflictDoNothing({ target: BillingUsageLedger.idempotency_key })
      .returning({ usageUuid: BillingUsageLedger.usage_uuid });
    if (!inserted) return;
    await db
      .update(BillingWallets)
      .set({
        balance_credits: sql`${BillingWallets.balance_credits} - ${charged}`,
        updated_at: new Date(),
      })
      .where(eq(BillingWallets.user_uuid, input.userUuid));
  } catch (error) {
    // Billing must never turn a successful model request into a failed product request.
    console.error("Billing usage record failed", error);
  }
};

export const getBillingSummary = async (userUuid: string) => {
  const wallet = await ensureWallet(userUuid);
  const rates = await resolvePlanUnitPrices(userUuid);
  const [usage] = await db
    .select({
      totalCredits: sql<string>`coalesce(sum(${BillingUsageLedger.charged_credits}), 0)`,
      totalQuantity: sql<string>`coalesce(sum(${BillingUsageLedger.quantity}), 0)`,
    })
    .from(BillingUsageLedger)
    .where(eq(BillingUsageLedger.user_uuid, userUuid));

  const tts1000 = rates.ttsCreditsPer1000Chars;
  const sttMin = rates.sttCreditsPerMinute;

  return GenResObj(Code.OK, true, "Billing summary fetched successfully", {
    balanceCredits: Math.max(0, Number(wallet?.balance_credits ?? 0)),
    balanceInr: Math.max(0, Number(wallet?.balance_credits ?? 0)),
    creditToInr: 1,
    overageCredits: Math.max(0, -Number(wallet?.balance_credits ?? 0)),
    initialCredits: initialCredits(),
    usedCredits: Number(usage?.totalCredits ?? 0),
    usageQuantity: Number(usage?.totalQuantity ?? 0),
    plan: rates.plan
      ? {
          planUuid: rates.plan.plan_uuid,
          code: rates.plan.code,
          name: rates.plan.name,
          ttsCreditsPer1000Chars: tts1000,
          sttCreditsPerMinute: sttMin,
        }
      : null,
    pricing: {
      tts_characters: {
        unit: "character",
        creditsPerUnit: rates.unitPrices.tts_characters,
        example: `1,000 characters = ₹${formatCredits(tts1000)} (${formatCredits(tts1000)} credits)`,
      },
      stt_seconds: {
        unit: "second",
        creditsPerUnit: rates.unitPrices.stt_seconds,
        example: `1 minute = ₹${formatCredits(sttMin)} (${formatCredits(sttMin)} credits)`,
      },
      llm_tokens: {
        unit: "token",
        creditsPerUnit: rates.unitPrices.llm_tokens,
        example: `1,000 tokens = ${formatCredits(1000 * rates.unitPrices.llm_tokens)} credits`,
      },
    },
  });
};

export const listBillingUsage = async (
  userUuid: string,
  page = 1,
  pageSize = 20,
  filters: {
    type?: "tts_characters" | "stt_seconds" | "llm_tokens";
    from?: Date;
    to?: Date;
  } = {},
) => {
  const conditions = and(
    eq(BillingUsageLedger.user_uuid, userUuid),
    filters.type ? eq(BillingUsageLedger.usage_type, filters.type) : undefined,
    filters.from ? gte(BillingUsageLedger.created_at, filters.from) : undefined,
    filters.to ? lte(BillingUsageLedger.created_at, filters.to) : undefined,
  );
  const rows = await db
    .select()
    .from(BillingUsageLedger)
    .where(conditions)
    .orderBy(desc(BillingUsageLedger.created_at))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return GenResObj(Code.OK, true, "Billing usage fetched successfully", {
    items: rows,
    page,
    pageSize,
  });
};
