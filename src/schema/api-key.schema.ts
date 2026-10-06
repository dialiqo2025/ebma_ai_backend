import { index, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { Users } from "./user.schema";

export type ApiKeyScope = "stt" | "tts" | "llm" | "translate";

export const ApiKeys = pgTable("api_keys", {
  key_uuid: uuid("key_uuid").defaultRandom().primaryKey(),
  user_uuid: uuid("user_uuid").notNull().references(() => Users.user_uuid, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  key_prefix: varchar("key_prefix", { length: 24 }).notNull(),
  key_hash: varchar("key_hash", { length: 64 }).notNull().unique(),
  scopes: jsonb("scopes").$type<ApiKeyScope[]>().default(["stt", "tts", "llm", "translate"]).notNull(),
  last_used_at: timestamp("last_used_at", { mode: "date" }),
  expires_at: timestamp("expires_at", { mode: "date" }),
  revoked_at: timestamp("revoked_at", { mode: "date" }),
  created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({ userIdx: index("api_keys_user_idx").on(table.user_uuid) }));
