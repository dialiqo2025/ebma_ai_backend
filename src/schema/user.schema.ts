import { boolean, integer, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { otpPurposeEnum, userRoleEnum } from "./enums.schema";

export const Users = pgTable("users", {
  user_uuid: uuid("user_uuid").defaultRandom().primaryKey(),
  fullName: varchar("full_name", { length: 255 }).notNull(),
  company_name: varchar("company_name", { length: 255 }),
  email: varchar("email", { length: 255 }).notNull().unique(),
  password: varchar("password", { length: 255 }),
  google_id: varchar("google_id", { length: 255 }).unique(),
  auth_provider: varchar("auth_provider", { length: 32 }).default("email").notNull(),
  role: userRoleEnum("role").default("user").notNull(),
  user_enabled: boolean("user_enabled").default(true).notNull(),
  email_verified: boolean("email_verified").default(false).notNull(),
  otp_code_hash: varchar("otp_code_hash", { length: 255 }),
  otp_expires_at: timestamp("otp_expires_at", { mode: "date" }),
  otp_purpose: otpPurposeEnum("otp_purpose"),
  otp_attempts: integer("otp_attempts").default(0).notNull(),
  otp_sent_at: timestamp("otp_sent_at", { mode: "date" }),
  last_login: timestamp("last_login", { mode: "date" }),
  created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});
