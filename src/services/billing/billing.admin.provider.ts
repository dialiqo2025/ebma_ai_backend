import { and, desc, eq } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { BillingPlans, BillingRates, BillingSubscriptions, BillingTransactions } from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";

const defaultRates = { tts_characters: 1, stt_seconds: 1, llm_tokens: 1 } as const;

export const listPlans = async (includeInactive = true) => {
  const rows = await db.select().from(BillingPlans).where(includeInactive ? undefined : eq(BillingPlans.active, true)).orderBy(desc(BillingPlans.created_at));
  return GenResObj(Code.OK, true, "Plans fetched successfully", rows);
};

export const createPlan = async (input: { code: string; name: string; description?: string; priceMinor: number; currency?: string; billingInterval?: string; planKind?: "service" | "wallet_topup"; credits: number; active?: boolean; features?: { stt: boolean; tts: boolean; llm: boolean }; benefits?: string[] }) => {
  const [plan] = await db.insert(BillingPlans).values({
    code: input.code.trim().toLowerCase(), name: input.name.trim(), description: input.description?.trim() || null,
    price_minor: input.priceMinor, currency: (input.currency || "INR").toUpperCase(), billing_interval: input.billingInterval || "one_time",
    plan_kind: input.planKind || (input.code.trim().toLowerCase().startsWith("wallet_") ? "wallet_topup" : "service"), monthly_credits: input.credits.toFixed(6), features: { ...(input.features ?? { stt: true, tts: true }), llm: true }, benefits: input.benefits ?? [], active: input.active ?? true,
  }).returning();
  return GenResObj(Code.CREATED, true, "Plan created successfully", plan);
};

export const updatePlan = async (planUuid: string, input: Partial<{ name: string; description: string; priceMinor: number; currency: string; billingInterval: string; planKind: "service" | "wallet_topup"; credits: number; active: boolean; features: { stt: boolean; tts: boolean; llm: boolean }; benefits: string[] }>) => {
  const [plan] = await db.update(BillingPlans).set({
    ...(input.name !== undefined ? { name: input.name.trim() } : {}), ...(input.description !== undefined ? { description: input.description.trim() } : {}),
    ...(input.priceMinor !== undefined ? { price_minor: input.priceMinor } : {}), ...(input.currency !== undefined ? { currency: input.currency.toUpperCase() } : {}),
    ...(input.billingInterval !== undefined ? { billing_interval: input.billingInterval } : {}), ...(input.planKind !== undefined ? { plan_kind: input.planKind } : {}), ...(input.credits !== undefined ? { monthly_credits: input.credits.toFixed(6) } : {}),
    ...(input.features !== undefined ? { features: { ...input.features, llm: true } } : {}),
    ...(input.benefits !== undefined ? { benefits: input.benefits } : {}),
    ...(input.active !== undefined ? { active: input.active } : {}), updated_at: new Date(),
  }).where(eq(BillingPlans.plan_uuid, planUuid)).returning();
  return plan ? GenResObj(Code.OK, true, "Plan updated successfully", plan) : GenResObj(Code.NOT_FOUND, false, "Plan not found");
};

export const listPublicPlans = async () => {
  const rows = await db.select().from(BillingPlans).where(eq(BillingPlans.active, true)).orderBy(desc(BillingPlans.created_at));
  return GenResObj(Code.OK, true, "Available plans fetched successfully", rows);
};

export const deletePlan = async (planUuid: string) => {
  const [plan] = await db.delete(BillingPlans).where(eq(BillingPlans.plan_uuid, planUuid)).returning({ planUuid: BillingPlans.plan_uuid });
  return plan ? GenResObj(Code.OK, true, "Plan deleted successfully") : GenResObj(Code.NOT_FOUND, false, "Plan not found");
};

export const listRates = async () => {
  const rows = await db.select().from(BillingRates);
  const values = { ...defaultRates, ...Object.fromEntries(rows.map((row) => [row.usage_type, Number(row.credits_per_unit)])) };
  return GenResObj(Code.OK, true, "Usage rates fetched successfully", values);
};

export const updateRates = async (input: Partial<typeof defaultRates>) => {
  for (const type of Object.keys(defaultRates) as Array<keyof typeof defaultRates>) {
    if (input[type] === undefined) continue;
    await db.insert(BillingRates).values({ usage_type: type, credits_per_unit: String(input[type]), updated_at: new Date() }).onConflictDoUpdate({ target: BillingRates.usage_type, set: { credits_per_unit: String(input[type]), updated_at: new Date() } });
  }
  return listRates();
};

export const listSubscriptions = async () => GenResObj(Code.OK, true, "Subscriptions fetched successfully", await db.select().from(BillingSubscriptions).orderBy(desc(BillingSubscriptions.created_at)));
export const listTransactions = async () => GenResObj(Code.OK, true, "Transactions fetched successfully", await db.select().from(BillingTransactions).orderBy(desc(BillingTransactions.created_at)));
export const listUserSubscriptions = async (userUuid: string) => GenResObj(Code.OK, true, "Subscriptions fetched successfully", await db.select({ subscription: BillingSubscriptions, plan: BillingPlans }).from(BillingSubscriptions).leftJoin(BillingPlans, eq(BillingSubscriptions.plan_uuid, BillingPlans.plan_uuid)).where(eq(BillingSubscriptions.user_uuid, userUuid)).orderBy(desc(BillingSubscriptions.created_at)));
export const listUserTransactions = async (userUuid: string) => GenResObj(Code.OK, true, "Transactions fetched successfully", await db.select({ transaction: BillingTransactions, plan: BillingPlans }).from(BillingTransactions).leftJoin(BillingPlans, eq(BillingTransactions.plan_uuid, BillingPlans.plan_uuid)).where(eq(BillingTransactions.user_uuid, userUuid)).orderBy(desc(BillingTransactions.created_at)));
export const getUserTransaction = async (userUuid: string, transactionUuid: string) => {
  const [row] = await db.select({ transaction: BillingTransactions, plan: BillingPlans }).from(BillingTransactions).leftJoin(BillingPlans, eq(BillingTransactions.plan_uuid, BillingPlans.plan_uuid)).where(and(eq(BillingTransactions.user_uuid, userUuid), eq(BillingTransactions.transaction_uuid, transactionUuid))).limit(1);
  return row ? GenResObj(Code.OK, true, "Transaction fetched successfully", row) : GenResObj(Code.NOT_FOUND, false, "Transaction not found");
};

export const getUserCapabilities = async (userUuid: string) => {
  const [subscription] = await db.select({ plan: BillingPlans, status: BillingSubscriptions.status })
    .from(BillingSubscriptions).leftJoin(BillingPlans, eq(BillingSubscriptions.plan_uuid, BillingPlans.plan_uuid))
    .where(and(eq(BillingSubscriptions.user_uuid, userUuid), eq(BillingSubscriptions.status, "active")))
    .orderBy(desc(BillingSubscriptions.created_at)).limit(1);
  // Existing accounts without a subscription retain the current product access.
  const features = subscription?.plan?.features ?? { stt: true, tts: true, llm: true };
  return GenResObj(Code.OK, true, "Capabilities fetched successfully", {
    plan: subscription?.plan?.name ?? "No plan",
    subscribed: Boolean(subscription?.plan),
    capabilities: { stt: Boolean(features.stt), tts: Boolean(features.tts), llm: true, llmMode: "user" },
  });
};
