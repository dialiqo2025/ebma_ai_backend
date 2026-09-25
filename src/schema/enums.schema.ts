import { pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", [
  "user",
  "admin",
  "superAdmin",
  "tenant",
]);

export const otpPurposeEnum = pgEnum("otp_purpose", [
  "signup",
  "login",
  "password_reset",
]);
