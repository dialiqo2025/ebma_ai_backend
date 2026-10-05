import { randomInt } from "node:crypto";
import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { db } from "../../config/database/connection.database";
import { Users } from "../../schema";
import { type OtpPurpose, renderEbmaOtpEmail, sendEmail } from "../../utils/email.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";

export type UserRecord = typeof Users.$inferSelect;

type OtpCompletionUpdates = {
  email_verified?: boolean;
  last_login?: Date;
};

type OtpIssueResult =
  | { sent: true; expiresIn: number }
  | { sent: false; retryAfter: number };

type OtpVerificationResult =
  | { ok: true }
  | { ok: false; code: Code; message: string };

const readIntegerEnv = (name: string, fallback: number, minimum: number) => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
};

const OTP_TTL_MINUTES = readIntegerEnv("OTP_TTL_MINUTES", 10, 1);
const OTP_RESEND_SECONDS = readIntegerEnv("OTP_RESEND_SECONDS", 60, 0);
const OTP_MAX_ATTEMPTS = readIntegerEnv("OTP_MAX_ATTEMPTS", 5, 1);

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET_KEY;
  if (!secret) throw new Error("JWT_SECRET_KEY must be configured");
  return secret;
};

const otpClearedValues = () => ({
  otp_code_hash: null,
  otp_expires_at: null,
  otp_purpose: null,
  otp_attempts: 0,
  otp_sent_at: null,
  updated_at: new Date(),
} as const);

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const getUserByEmail = async (email: string) => {
  const [user] = await db
    .select()
    .from(Users)
    .where(eq(Users.email, normalizeEmail(email)))
    .limit(1);

  return user;
};

export const sanitizeUser = (user: UserRecord) => {
  const {
    password: _password,
    google_id: _googleId,
    microsoft_id: _microsoftId,
    apple_id: _appleId,
    otp_code_hash: _otpHash,
    otp_expires_at: _otpExpiry,
    otp_attempts: _otpAttempts,
    otp_purpose: _otpPurpose,
    otp_sent_at: _otpSentAt,
    ...safeUser
  } = user;

  return safeUser;
};

export const hashPassword = (password: string) => {
  if (!password) throw new Error("Password is required");
  return bcrypt.hash(password, 10);
};

export const comparePassword = (plainPassword: string, hashedPassword: string | null) => {
  if (!hashedPassword) return Promise.resolve(false);
  return bcrypt.compare(plainPassword, hashedPassword);
};

export const getUserByGoogleId = async (googleId: string) => {
  const [user] = await db
    .select()
    .from(Users)
    .where(eq(Users.google_id, googleId))
    .limit(1);
  return user;
};

export const getUserByMicrosoftId = async (microsoftId: string) => {
  const [user] = await db
    .select()
    .from(Users)
    .where(eq(Users.microsoft_id, microsoftId))
    .limit(1);
  return user;
};

export const getUserByAppleId = async (appleId: string) => {
  const [user] = await db
    .select()
    .from(Users)
    .where(eq(Users.apple_id, appleId))
    .limit(1);
  return user;
};

export const createAccessToken = (id: string, role: string) => {
  const expiresInSeconds = 30 * 24 * 60 * 60;
  const token = jwt.sign({ id, role }, getJwtSecret(), { expiresIn: expiresInSeconds });
  return `Bearer ${token}`;
};

export const createResetToken = (id: string) => {
  const expiresInSeconds = 15 * 60;
  const token = jwt.sign({ id, purpose: "password_reset" }, getJwtSecret(), {
    expiresIn: expiresInSeconds,
  });
  return `Bearer ${token}`;
};

export const getResetTokenPayload = (authorization?: string) => {
  const token = authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  try {
    const payload = jwt.verify(token, getJwtSecret()) as { id?: string; purpose?: string };
    return payload.id && payload.purpose === "password_reset"
      ? { id: payload.id }
      : null;
  } catch {
    return null;
  }
};

export const clearOtpChallenge = (userId: string) =>
  db.update(Users).set(otpClearedValues()).where(eq(Users.user_uuid, userId));

export const completeOtpChallenge = async (
  userId: string,
  updates: OtpCompletionUpdates = {},
) => {
  const [updatedUser] = await db
    .update(Users)
    .set({ ...otpClearedValues(), ...updates })
    .where(eq(Users.user_uuid, userId))
    .returning();

  return updatedUser;
};

export const issueOtpChallenge = async (
  user: UserRecord,
  purpose: OtpPurpose,
  enforceCooldown = true,
): Promise<OtpIssueResult> => {
  if (enforceCooldown && user.otp_sent_at) {
    const elapsedSeconds = Math.floor((Date.now() - user.otp_sent_at.getTime()) / 1000);
    if (elapsedSeconds < OTP_RESEND_SECONDS) {
      return { sent: false, retryAfter: OTP_RESEND_SECONDS - elapsedSeconds };
    }
  }

  // const code = randomInt(100_000, 1_000_000).toString();
  const code = "123456";
  const otpHash = await bcrypt.hash(code, 8);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000);

  await db
    .update(Users)
    .set({
      otp_code_hash: otpHash,
      otp_expires_at: expiresAt,
      otp_purpose: purpose,
      otp_attempts: 0,
      otp_sent_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(Users.user_uuid, user.user_uuid));

  // Temp Change : Hide to prevent sending emails during development. Uncomment the following lines to enable email sending in production.
  // const html = renderEbmaOtpEmail({
  //   name: user.fullName,
  //   code,
  //   purpose,
  //   expiresInMinutes: OTP_TTL_MINUTES,
  // });

  // await sendEmail({
  //   to: user.email,
  //   subject: `${code} is your ebma AI verification code`,
  //   html,
  // });

  return { sent: true, expiresIn: OTP_TTL_MINUTES * 60 };
};

export const verifyOtpChallenge = async (
  user: UserRecord,
  code: string,
  expectedPurpose: OtpPurpose,
): Promise<OtpVerificationResult> => {
  if (!user.otp_code_hash || !user.otp_expires_at || user.otp_purpose !== expectedPurpose) {
    return {
      ok: false,
      code: Code.BAD_REQUEST,
      message: "No matching OTP request was found",
    };
  }

  if (Date.now() > user.otp_expires_at.getTime()) {
    await clearOtpChallenge(user.user_uuid);
    return { ok: false, code: Code.BAD_REQUEST, message: "OTP code has expired" };
  }

  if (user.otp_attempts >= OTP_MAX_ATTEMPTS) {
    await clearOtpChallenge(user.user_uuid);
    return {
      ok: false,
      code: Code.TOO_MANY_REQUESTS,
      message: "Too many incorrect attempts. Request a new code",
    };
  }

  if (await bcrypt.compare(code, user.otp_code_hash)) return { ok: true };

  const attempts = user.otp_attempts + 1;
  if (attempts >= OTP_MAX_ATTEMPTS) {
    await clearOtpChallenge(user.user_uuid);
    return {
      ok: false,
      code: Code.TOO_MANY_REQUESTS,
      message: "Too many incorrect attempts. Request a new code",
    };
  }

  await db
    .update(Users)
    .set({ otp_attempts: attempts, updated_at: new Date() })
    .where(eq(Users.user_uuid, user.user_uuid));

  return { ok: false, code: Code.BAD_REQUEST, message: "Invalid OTP code" };
};
