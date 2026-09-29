import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { BillingUsageLedger, BillingWallets } from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";

export const BILLING_PRICES = {
  tts_characters: Number(process.env.BILLING_TTS_CREDITS_PER_CHARACTER ?? 1),
  stt_seconds: Number(process.env.BILLING_STT_CREDITS_PER_SECOND ?? 1),
  llm_tokens: Number(process.env.BILLING_LLM_CREDITS_PER_TOKEN ?? 1),
} as const;

const initialCredits = () => {
  const value = Number(process.env.BILLING_INITIAL_CREDITS ?? 1000);
  return Number.isFinite(value) && value >= 0 ? value : 1000;
};

const formatCredits = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2);

const ensureWallet = async (userUuid: string) => {
  const [wallet] = await db.insert(BillingWallets).values({ user_uuid: userUuid, balance_credits: initialCredits().toFixed(6) }).onConflictDoNothing({ target: BillingWallets.user_uuid }).returning();
  if (wallet) return wallet;
  const [existing] = await db.select().from(BillingWallets).where(eq(BillingWallets.user_uuid, userUuid)).limit(1);
  return existing;
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
  const unitPrice = BILLING_PRICES[input.type];
  const charged = input.quantity * unitPrice;
  try {
    await ensureWallet(input.userUuid);
    const [inserted] = await db.insert(BillingUsageLedger).values({
      user_uuid: input.userUuid,
      usage_type: input.type,
      quantity: input.quantity.toFixed(6),
      unit_price_credits: unitPrice.toFixed(6),
      charged_credits: charged.toFixed(6),
      idempotency_key: input.idempotencyKey,
      provider_reference: input.providerReference,
      metadata: input.metadata,
    }).onConflictDoNothing({ target: BillingUsageLedger.idempotency_key }).returning({ usageUuid: BillingUsageLedger.usage_uuid });
    if (!inserted) return;
    await db.update(BillingWallets).set({
      balance_credits: sql`${BillingWallets.balance_credits} - ${charged}`,
      updated_at: new Date(),
    }).where(eq(BillingWallets.user_uuid, input.userUuid));
  } catch (error) {
    // Billing must never turn a successful model request into a failed product request.
    console.error("Billing usage record failed", error);
  }
};

export const getBillingSummary = async (userUuid: string) => {
  const wallet = await ensureWallet(userUuid);
  const [usage] = await db.select({
    totalCredits: sql<string>`coalesce(sum(${BillingUsageLedger.charged_credits}), 0)`,
    totalQuantity: sql<string>`coalesce(sum(${BillingUsageLedger.quantity}), 0)`,
  }).from(BillingUsageLedger).where(eq(BillingUsageLedger.user_uuid, userUuid));
  return GenResObj(Code.OK, true, "Billing summary fetched successfully", {
    balanceCredits: Math.max(0, Number(wallet?.balance_credits ?? 0)),
    overageCredits: Math.max(0, -Number(wallet?.balance_credits ?? 0)),
    usedCredits: Number(usage?.totalCredits ?? 0),
    usageQuantity: Number(usage?.totalQuantity ?? 0),
    pricing: {
      tts_characters: { unit: "character", creditsPerUnit: BILLING_PRICES.tts_characters, example: `1,000 characters = ${formatCredits(1000 * BILLING_PRICES.tts_characters)} credits` },
      stt_seconds: { unit: "second", creditsPerUnit: BILLING_PRICES.stt_seconds, example: `60 seconds = ${formatCredits(60 * BILLING_PRICES.stt_seconds)} credits` },
      llm_tokens: { unit: "token", creditsPerUnit: BILLING_PRICES.llm_tokens, example: `1,000 tokens = ${formatCredits(1000 * BILLING_PRICES.llm_tokens)} credits` },
    },
  });
};

export const listBillingUsage = async (userUuid: string, page = 1, pageSize = 20, filters: { type?: "tts_characters" | "stt_seconds" | "llm_tokens"; from?: Date; to?: Date } = {}) => {
  const conditions = and(
    eq(BillingUsageLedger.user_uuid, userUuid),
    filters.type ? eq(BillingUsageLedger.usage_type, filters.type) : undefined,
    filters.from ? gte(BillingUsageLedger.created_at, filters.from) : undefined,
    filters.to ? lte(BillingUsageLedger.created_at, filters.to) : undefined,
  );
  const rows = await db.select().from(BillingUsageLedger).where(conditions).orderBy(desc(BillingUsageLedger.created_at)).limit(pageSize).offset((page - 1) * pageSize);
  return GenResObj(Code.OK, true, "Billing usage fetched successfully", { items: rows, page, pageSize });
};
