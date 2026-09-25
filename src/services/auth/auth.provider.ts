import { eq } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { Users } from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import { sendUserPasswordUpdatedEmail } from "../user/user.helper";
import {
  clearOtpChallenge,
  comparePassword,
  completeOtpChallenge,
  createResetToken,
  createAccessToken,
  getResetTokenPayload,
  getUserByEmail,
  hashPassword,
  issueOtpChallenge,
  normalizeEmail,
  sanitizeUser,
  verifyOtpChallenge,
} from "./auth.helper";
import {
  otpEmailType,
  passwordResetOtpVerifyType,
  resetPasswordType,
  signInOtpVerifyType,
  signInType,
  signUpOtpVerifyType,
  signUpType,
  updateProfileType,
} from "./auth.validate";

export const signUp = async (payload: signUpType) => {
  const email = normalizeEmail(payload.email);
  const existingUser = await getUserByEmail(email);

  if (existingUser) {
    return GenResObj(
      Code.CONFLICT,
      false,
      existingUser.email_verified
        ? "An account with this email already exists"
        : "This email is already registered and awaiting verification",
      { verificationRequired: !existingUser.email_verified, email },
    );
  }

  const hashedPassword = await hashPassword(payload.password);
  const [newUser] = await db
    .insert(Users)
    .values({
      fullName: payload.fullName.trim(),
      company_name: payload.company_name?.trim() || null,
      email,
      password: hashedPassword,
      role: "user",
      email_verified: false,
    })
    .returning();

  if (!newUser) throw new Error("User creation failed");
  const otp = await issueOtpChallenge(newUser, "signup", false);

  return GenResObj(Code.CREATED, true, "Verification code sent to your email", {
    user_uuid: newUser.user_uuid,
    email: newUser.email,
    verificationRequired: true,
    expiresIn: otp.sent ? otp.expiresIn : undefined,
  });
};

export const verifySignUpOtp = async (payload: signUpOtpVerifyType) => {
  const user = await getUserByEmail(payload.email);
  if (!user) return GenResObj(Code.NOT_FOUND, false, "User not found");
  if (user.email_verified) return GenResObj(Code.CONFLICT, false, "Email is already verified");

  const result = await verifyOtpChallenge(user, payload.code, "signup");
  if (!result.ok) return GenResObj(result.code, false, result.message);

  const verifiedUser = await completeOtpChallenge(user.user_uuid, {
    email_verified: true,
    last_login: new Date(),
  });

  if (!verifiedUser) throw new Error("Email verification failed");
  const token = createAccessToken(verifiedUser.user_uuid, verifiedUser.role);
  return GenResObj(Code.OK, true, "Email verified successfully", {
    token,
    user: sanitizeUser(verifiedUser),
  });
};

export const resendSignUpOtp = async (payload: otpEmailType) => {
  const user = await getUserByEmail(payload.email);
  if (!user) return GenResObj(Code.NOT_FOUND, false, "User not found");
  if (user.email_verified) return GenResObj(Code.CONFLICT, false, "Email is already verified");

  const otp = await issueOtpChallenge(user, "signup");
  if (!otp.sent) {
    return GenResObj(Code.TOO_MANY_REQUESTS, false, "Please wait before requesting another code", {
      retryAfter: otp.retryAfter,
    });
  }

  return GenResObj(Code.OK, true, "A new verification code was sent", {
    email: user.email,
    expiresIn: otp.expiresIn,
  });
};

export const signIn = async (payload: signInType) => {
  const user = await getUserByEmail(payload.email);
  if (!user || !(await comparePassword(payload.password, user.password))) {
    return GenResObj(Code.UNAUTHORIZED, false, "Invalid email or password");
  }
  if (!user.user_enabled) return GenResObj(Code.FORBIDDEN, false, "This account has been disabled");
  if (!user.email_verified) {
    return GenResObj(Code.FORBIDDEN, false, "Verify your email before signing in", {
      verificationRequired: true,
      email: user.email,
    });
  }

  const otp = await issueOtpChallenge(user, "login");
  if (!otp.sent) {
    return GenResObj(Code.TOO_MANY_REQUESTS, false, "A sign-in code was already sent", {
      retryAfter: otp.retryAfter,
    });
  }

  return GenResObj(Code.OK, true, "Sign-in code sent", {
    otpRequired: true,
    email: user.email,
    expiresIn: otp.expiresIn,
  });
};

export const verifySignInOtp = async (payload: signInOtpVerifyType) => {
  const user = await getUserByEmail(payload.email);
  if (!user) return GenResObj(Code.NOT_FOUND, false, "User not found");

  const result = await verifyOtpChallenge(user, payload.code, "login");
  if (!result.ok) return GenResObj(result.code, false, result.message);

  const signedInUser = await completeOtpChallenge(user.user_uuid, {
    last_login: new Date(),
  });

  if (!signedInUser) throw new Error("Sign-in verification failed");
  const token = createAccessToken(signedInUser.user_uuid, signedInUser.role);
  return GenResObj(Code.OK, true, "Sign-in verified successfully", {
    token,
    user: sanitizeUser(signedInUser),
  });
};

export const updateProfile = async (req: any, payload: updateProfileType) => {
  const userId = req.user?.userId;
  if (!userId) return GenResObj(Code.UNAUTHORIZED, false, "Unauthorized");

  const [user] = await db.select().from(Users).where(eq(Users.user_uuid, userId)).limit(1);
  if (!user) return GenResObj(Code.NOT_FOUND, false, "User not found");
  if (user.email !== normalizeEmail(payload.email)) {
    return GenResObj(Code.BAD_REQUEST, false, "Email does not match");
  }
  if (!(await comparePassword(payload.currentPassword, user.password))) {
    return GenResObj(Code.BAD_REQUEST, false, "Current password is incorrect");
  }
  if (payload.newPassword !== payload.confirmNewPassword) {
    return GenResObj(Code.BAD_REQUEST, false, "Passwords do not match");
  }

  const [updatedUser] = await db
    .update(Users)
    .set({ password: await hashPassword(payload.newPassword), updated_at: new Date() })
    .where(eq(Users.user_uuid, userId))
    .returning();
  if (!updatedUser) throw new Error("Password update failed");

  await sendUserPasswordUpdatedEmail({
    to: updatedUser.email,
    name: updatedUser.fullName,
    email: updatedUser.email,
    password: payload.newPassword,
    role: updatedUser.role,
  });

  return GenResObj(Code.OK, true, "Password updated successfully");
};

export const requestPasswordResetOtp = async (payload: otpEmailType) => {
  const user = await getUserByEmail(payload.email);
  // Prevent account enumeration for password-reset requests.
  if (!user || !user.email_verified) {
    return GenResObj(Code.OK, true, "If that account exists, a reset code has been sent");
  }

  const otp = await issueOtpChallenge(user, "password_reset");
  if (!otp.sent) {
    return GenResObj(Code.TOO_MANY_REQUESTS, false, "Please wait before requesting another code", {
      retryAfter: otp.retryAfter,
    });
  }

  return GenResObj(Code.OK, true, "If that account exists, a reset code has been sent", {
    expiresIn: otp.expiresIn,
  });
};

export const verifyPasswordResetOtp = async (payload: passwordResetOtpVerifyType) => {
  const user = await getUserByEmail(payload.email);
  if (!user) return GenResObj(Code.BAD_REQUEST, false, "Invalid or expired OTP code");

  const result = await verifyOtpChallenge(user, payload.code, "password_reset");
  if (!result.ok) return GenResObj(result.code, false, result.message);

  await clearOtpChallenge(user.user_uuid);
  return GenResObj(Code.OK, true, "OTP verified", {
    token: createResetToken(user.user_uuid),
  });
};

export const resetPassword = async (payload: resetPasswordType, authHeader?: string) => {
  const resetToken = getResetTokenPayload(authHeader);
  if (!resetToken) return GenResObj(Code.UNAUTHORIZED, false, "Reset token is invalid or expired");

  const [updatedUser] = await db
    .update(Users)
    .set({
      password: await hashPassword(payload.newPassword),
      updated_at: new Date(),
    })
    .where(eq(Users.user_uuid, resetToken.id))
    .returning();

  if (!updatedUser) return GenResObj(Code.NOT_FOUND, false, "User not found");
  await sendUserPasswordUpdatedEmail({
    to: updatedUser.email,
    name: updatedUser.fullName,
    email: updatedUser.email,
    password: payload.newPassword,
    role: updatedUser.role,
  });

  return GenResObj(Code.OK, true, "Password reset successfully");
};
