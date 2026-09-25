import { z } from "zod";

export const createUserValidator = z.object({
  fullName: z.string().min(1, "Full name is required"),
  email: z.string().email("Invalid email format"),
  role: z.enum(["user", "admin", "superAdmin", "tenant"]),
  password: z.string().min(6, "Password must be at least 6 characters"),
  isActive: z.boolean(),
});

export type createUserType = z.infer<typeof createUserValidator>;

export const updateUserValidator = z.object({
  fullName: z.string().min(1, "Full name is required").optional(),
  email: z.string().email("Invalid email format").optional(),
  role: z.enum(["user", "admin", "superAdmin", "tenant"]).optional(),
  password: z.string().min(6, "Password must be at least 6 characters").optional(),
  isActive: z.boolean().optional(),
});

export type updateUserType = z.infer<typeof updateUserValidator>;

export const userUuidValidator = z.string().uuid("Invalid user_uuid");
