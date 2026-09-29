import { boolean, numeric, pgTable, timestamp, uuid, varchar, jsonb, index } from "drizzle-orm/pg-core";
import { Users } from "./user.schema";
import { billingUsageTypeEnum } from "./enums.schema";

export const BillingPlans = pgTable("billing_plans", {
  plan_uuid: uuid("plan_uuid").defaultRandom().primaryKey(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  monthly_credits: numeric("monthly_credits", { precision: 18, scale: 6 }).default("0").notNull(),
  active: boolean("active").default(true).notNull(),
  created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
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
