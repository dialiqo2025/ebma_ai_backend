import { z } from "zod";

export const signUpValidator = z.object({
  email: z.string().email("Invalid email format"),
  fullName: z
    .string()
    .min(1, "Full name is required")
    .min(3, "Full name must be at least 3 characters"),
  company_name: z
    .string()
    .min(1, "Company name is required")
    .min(3, "Company name must be at least 3 characters")
    .optional(),
});

export type signUpType = z.infer<typeof signUpValidator>;

export const signInValidator = z.object({
  email: z.string().email("Invalid email format"),
});

export type signInType = z.infer<typeof signInValidator>;

const emailOtpValidator = z.object({
  email: z.string().email("Invalid email format"),
  code: z.string().regex(/^\d{6}$/, "OTP code must contain exactly 6 digits"),
});

export const signUpOtpVerifyValidator = emailOtpValidator;
export type signUpOtpVerifyType = z.infer<typeof signUpOtpVerifyValidator>;

export const signInOtpVerifyValidator = emailOtpValidator;
export type signInOtpVerifyType = z.infer<typeof signInOtpVerifyValidator>;

export const updateProfileValidator = z.object({
  email: z.string().email("Invalid email format"),
  currentPassword: z.string().min(6, "Current password is required"),
  newPassword: z.string().min(6, "New password must be at least 6 characters"),
  confirmNewPassword: z.string().min(6, "Confirm password is required"),
});

export type updateProfileType = z.infer<typeof updateProfileValidator>;

export const otpEmailValidator = z.object({
  email: z.string().email("Invalid email format"),
});

export type otpEmailType = z.infer<typeof otpEmailValidator>;

export const passwordResetOtpVerifyValidator = emailOtpValidator;
export type passwordResetOtpVerifyType = z.infer<typeof passwordResetOtpVerifyValidator>;

export const resetPasswordValidator = z.object({
  newPassword: z.string().min(8, "New password must be at least 8 characters").max(72),
});

export type resetPasswordType = z.infer<typeof resetPasswordValidator>;
