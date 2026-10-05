import { boolean, integer, numeric, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { Users } from "./user.schema";

export const LlmModelConfigs = pgTable("llm_model_configs", {
  model_uuid: uuid("model_uuid").defaultRandom().primaryKey(),
  provider: varchar("provider", { length: 32 }).notNull(),
  model_name: varchar("model_name", { length: 128 }).notNull(),
  display_name: varchar("display_name", { length: 160 }).notNull(),
  endpoint: varchar("endpoint", { length: 500 }),
  api_key: varchar("api_key", { length: 1000 }),
  temperature: numeric("temperature", { precision: 4, scale: 2 }).default("0.7").notNull(),
  max_tokens: integer("max_tokens").default(1024).notNull(),
  timeout_ms: integer("timeout_ms").default(30000).notNull(),
  active: boolean("active").default(true).notNull(),
  is_default: boolean("is_default").default(false).notNull(),
  created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});

export const UserLlmConfigs = pgTable("user_llm_configs", {
  config_uuid: uuid("config_uuid").defaultRandom().primaryKey(),
  user_uuid: uuid("user_uuid").notNull().unique().references(() => Users.user_uuid, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 32 }).notNull(),
  model_name: varchar("model_name", { length: 128 }).notNull(),
  endpoint: varchar("endpoint", { length: 500 }),
  api_key: varchar("api_key", { length: 1000 }).notNull(),
  temperature: numeric("temperature", { precision: 4, scale: 2 }).default("0.7").notNull(),
  max_tokens: integer("max_tokens").default(1024).notNull(),
  top_p: numeric("top_p", { precision: 4, scale: 2 }).default("1").notNull(),
  timeout_ms: integer("timeout_ms").default(30000).notNull(),
  created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});
