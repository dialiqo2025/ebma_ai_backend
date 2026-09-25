import { z } from "zod";

const languageValidator = z
  .string()
  .trim()
  .min(2, "Language is required")
  .max(32, "Language must be at most 32 characters")
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "Language must be a name or language code");

const ttsFields = {
  text: z
    .string()
    .trim()
    .min(1, "Text is required")
    .max(1500, "Text must be at most 1500 characters"),
  language: languageValidator.default("auto"),
  voiceMode: z.enum(["default", "clone"]).default("default"),
  voiceId: z.string().trim().min(1).max(255).optional(),
  speed: z.number().min(0.5).max(1.5).default(1),
  pitch: z.number().min(0.5).max(1.5).default(1),
  outputFormat: z.enum(["wav", "mp3", "ogg"]).default("wav"),
};

const requireCloneVoice = <T extends z.ZodTypeAny>(schema: T) =>
  schema.superRefine((value: any, context) => {
    if (value.voiceMode === "clone" && !value.voiceId) {
      context.addIssue({
        code: "custom",
        path: ["voiceId"],
        message: "voiceId is required when voiceMode is clone",
      });
    }
  });

export const createTtsGenerationValidator = requireCloneVoice(
  z.object(ttsFields).strict(),
);

export const updateTtsGenerationValidator = requireCloneVoice(
  z
    .object({
      text: ttsFields.text.optional(),
      language: languageValidator.optional(),
      voiceMode: z.enum(["default", "clone"]).optional(),
      voiceId: z.string().trim().min(1).max(255).nullable().optional(),
      speed: z.number().min(0.5).max(1.5).optional(),
      pitch: z.number().min(0.5).max(1.5).optional(),
      outputFormat: z.enum(["wav", "mp3", "ogg"]).optional(),
    })
    .strict()
    .refine((payload) => Object.keys(payload).length > 0, "At least one field is required"),
);

export const ttsGenerationUuidValidator = z.string().uuid("Invalid generation UUID");

export const listTtsGenerationsValidator = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(["queued", "processing", "completed", "failed"]).optional(),
  language: languageValidator.optional(),
  search: z.string().trim().max(100).optional(),
});

export type CreateTtsGeneration = z.infer<typeof createTtsGenerationValidator>;
export type UpdateTtsGeneration = z.infer<typeof updateTtsGenerationValidator>;
export type ListTtsGenerations = z.infer<typeof listTtsGenerationsValidator>;
