import { z } from "zod";

export const contactInquiryValidator = z
  .object({
    fullName: z.string().trim().min(2, "Full name is required").max(100),
    workEmail: z.string().trim().email("Enter a valid work email").max(254),
    company: z.string().trim().min(2, "Company name is required").max(120),
    jobTitle: z.string().trim().max(100).optional().default(""),
    phone: z
      .string()
      .trim()
      .max(30)
      .refine(
        (value) => !value || /^[+()0-9.\-\s]{7,30}$/.test(value),
        "Enter a valid phone number",
      )
      .optional()
      .default(""),
    inquiryType: z.enum([
      "custom_pricing",
      "sales",
      "partnership",
      "support",
      "general",
    ]),
    services: z
      .array(z.enum(["stt", "tts", "llm"]))
      .max(3)
      .optional()
      .default([]),
    monthlyUsage: z
      .enum(["exploring", "small", "growing", "high_volume", "not_sure"])
      .optional()
      .default("not_sure"),
    message: z
      .string()
      .trim()
      .min(20, "Tell us a little more about your requirements")
      .max(4_000),
    consent: z.literal(true, { error: "Consent is required" }),
    website: z.string().max(200).optional().default(""),
  })
  .strict();

export type ContactInquiryInput = z.infer<typeof contactInquiryValidator>;
