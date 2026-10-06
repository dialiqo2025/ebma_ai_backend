import { boolean, integer, numeric, pgTable, timestamp, uuid, varchar, jsonb, index } from "drizzle-orm/pg-core";
import { Users } from "./user.schema";
import { billingUsageTypeEnum } from "./enums.schema";

export const BillingPlans = pgTable("billing_plans", {
  plan_uuid: uuid("plan_uuid").defaultRandom().primaryKey(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  description: varchar("description", { length: 500 }),
  price_minor: integer("price_minor").default(0).notNull(),
  currency: varchar("currency", { length: 3 }).default("INR").notNull(),
  billing_interval: varchar("billing_interval", { length: 20 }).default("one_time").notNull(),
  plan_kind: varchar("plan_kind", { length: 20 }).default("service").notNull(),
  monthly_credits: numeric("monthly_credits", { precision: 18, scale: 6 }).default("0").notNull(),
  /** Credits (₹) charged per 1000 TTS characters. 1 credit = ₹1. */
  tts_credits_per_1000_chars: numeric("tts_credits_per_1000_chars", { precision: 18, scale: 6 }),
  /** Credits (₹) charged per 1 minute of STT audio. 1 credit = ₹1. */
  stt_credits_per_minute: numeric("stt_credits_per_minute", { precision: 18, scale: 6 }),
  /** Credits (₹) charged per 1,000 LLM tokens. 1 credit = ₹1. */
  llm_credits_per_1000_tokens: numeric("llm_credits_per_1000_tokens", { precision: 18, scale: 6 }),
  /** When true, new users are auto-assigned this plan (PAYG). */
  is_default: boolean("is_default").default(false).notNull(),
  /** Marketing-only tier (Contact us); not purchasable. */
  contact_only: boolean("contact_only").default(false).notNull(),
  features: jsonb("features").$type<{ stt: boolean; tts: boolean; llm: boolean }>().default({ stt: true, tts: true, llm: true }).notNull(),
  benefits: jsonb("benefits").$type<string[]>().default([]).notNull(),
  llm_mode: varchar("llm_mode", { length: 20 }).default("platform").notNull(),
  stripe_price_id: varchar("stripe_price_id", { length: 255 }),
  active: boolean("active").default(true).notNull(),
  created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});

export const BillingRates = pgTable("billing_rates", {
  rate_uuid: uuid("rate_uuid").defaultRandom().primaryKey(),
  usage_type: billingUsageTypeEnum("usage_type").notNull().unique(),
  credits_per_unit: numeric("credits_per_unit", { precision: 18, scale: 6 }).notNull(),
  updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});

export const BillingWallets = pgTable("billing_wallets", {
  wallet_uuid: uuid("wallet_uuid").defaultRandom().primaryKey(),
  user_uuid: uuid("user_uuid").notNull().unique().references(() => Users.user_uuid, { onDelete: "cascade" }),
  balance_credits: numeric("balance_credits", { precision: 18, scale: 6 }).default("0").notNull(),
  updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});

export const BillingUsageLedger = pgTable("billing_usage_ledger", {
  usage_uuid: uuid("usage_uuid").defaultRandom().primaryKey(),
  user_uuid: uuid("user_uuid").notNull().references(() => Users.user_uuid, { onDelete: "cascade" }),
  usage_type: billingUsageTypeEnum("usage_type").notNull(),
  quantity: numeric("quantity", { precision: 18, scale: 6 }).notNull(),
  unit_price_credits: numeric("unit_price_credits", { precision: 18, scale: 6 }).notNull(),
  charged_credits: numeric("charged_credits", { precision: 18, scale: 6 }).notNull(),
  provider_reference: varchar("provider_reference", { length: 255 }),
  idempotency_key: varchar("idempotency_key", { length: 255 }).notNull().unique(),
  metadata: jsonb("metadata"),
  created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  userCreatedIdx: index("billing_usage_user_created_idx").on(table.user_uuid, table.created_at),
}));

export const BillingSubscriptions = pgTable("billing_subscriptions", {
  subscription_uuid: uuid("subscription_uuid").defaultRandom().primaryKey(),
  user_uuid: uuid("user_uuid").notNull().references(() => Users.user_uuid, { onDelete: "cascade" }),
  plan_uuid: uuid("plan_uuid").references(() => BillingPlans.plan_uuid, { onDelete: "set null" }),
  status: varchar("status", { length: 32 }).notNull().default("active"),
  stripe_subscription_id: varchar("stripe_subscription_id", { length: 255 }).unique(),
  current_period_start: timestamp("current_period_start", { mode: "date" }),
  current_period_end: timestamp("current_period_end", { mode: "date" }),
  created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({ userIdx: index("billing_subscription_user_idx").on(table.user_uuid) }));

export const BillingTransactions = pgTable("billing_transactions", {
  transaction_uuid: uuid("transaction_uuid").defaultRandom().primaryKey(),
  user_uuid: uuid("user_uuid").notNull().references(() => Users.user_uuid, { onDelete: "cascade" }),
  plan_uuid: uuid("plan_uuid").references(() => BillingPlans.plan_uuid, { onDelete: "set null" }),
  amount_minor: integer("amount_minor").notNull().default(0),
  currency: varchar("currency", { length: 3 }).notNull().default("INR"),
  payment_method: varchar("payment_method", { length: 32 }).notNull().default("stripe"),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  stripe_checkout_session_id: varchar("stripe_checkout_session_id", { length: 255 }).unique(),
  stripe_payment_intent_id: varchar("stripe_payment_intent_id", { length: 255 }).unique(),
  razorpay_order_id: varchar("razorpay_order_id", { length: 255 }).unique(),
  razorpay_payment_id: varchar("razorpay_payment_id", { length: 255 }).unique(),
  razorpay_payment_link_id: varchar("razorpay_payment_link_id", { length: 255 }).unique(),
  metadata: jsonb("metadata"),
  created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({ userIdx: index("billing_transaction_user_idx").on(table.user_uuid) }));
