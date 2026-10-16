import { z } from "zod";

const language = z
  .string()
  .trim()
  .min(2, "Language is required")
  .max(32, "Language must be at most 32 characters")
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "Invalid language code");

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && !value.trim() ? undefined : value),
    z.string().trim().max(max).optional(),
  );

export const createTtsVoiceValidator = z
  .object({
    name: z.string().trim().min(2).max(100),
    language: language.default("en"),
    description: optionalText(280),
    referenceText: optionalText(2000),
    consentAccepted: z.preprocess(
      (value) => value === true || value === "true",
      z.literal(true, { message: "Voice consent is required" }),
    ),
  })
  .strict();

export const updateTtsVoiceValidator = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    language: language.optional(),
    description: z.string().trim().max(280).nullable().optional(),
    referenceText: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const ttsVoiceUuidValidator = z.string().uuid("Invalid voice UUID");

export const listTtsVoicesValidator = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(12),
});

export type CreateTtsVoice = z.infer<typeof createTtsVoiceValidator>;
export type UpdateTtsVoice = z.infer<typeof updateTtsVoiceValidator>;
