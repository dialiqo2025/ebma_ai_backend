import { z } from "zod";
import { TTS_EMOTIONS } from "./tts.emotion";

const languageValidator = z
  .string()
  .trim()
  .min(2, "Language is required")
  .max(32, "Language must be at most 32 characters")
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "Language must be a name or language code");

/** Empty string / null from JSON or multipart → null (no emotion). */
const emotionField = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return value;
}, z.enum(TTS_EMOTIONS).nullable().optional());

const sampleTranscriptField = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : "";
}, z.string().max(2000, "Sample transcript must be at most 2000 characters").optional());

const ttsFields = {
  text: z
    .string()
    .trim()
    .min(1, "Text is required")
    .max(1500, "Text must be at most 1500 characters"),
  language: languageValidator.default("auto"),
  voiceMode: z.enum(["default", "clone"]).default("default"),
  /** Legacy optional id; clone now uses uploaded `voiceSample` → GPU `reference`. */
  voiceId: z.string().trim().min(1).max(255).optional(),
  sampleTranscript: sampleTranscriptField,
  emotion: emotionField,
  speed: z.coerce.number().min(0.5).max(1.5).default(1),
  pitch: z.coerce.number().min(0.5).max(1.5).default(1),
  outputFormat: z.enum(["wav", "mp3", "ogg"]).default("wav"),
};

export const createTtsGenerationValidator = z.object(ttsFields).strict();

export const updateTtsGenerationValidator = z
  .object({
    text: ttsFields.text.optional(),
    language: languageValidator.optional(),
    voiceMode: z.enum(["default", "clone"]).optional(),
    voiceId: z.string().trim().min(1).max(255).nullable().optional(),
    sampleTranscript: sampleTranscriptField,
    emotion: emotionField,
    speed: z.coerce.number().min(0.5).max(1.5).optional(),
    pitch: z.coerce.number().min(0.5).max(1.5).optional(),
    outputFormat: z.enum(["wav", "mp3", "ogg"]).optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, "At least one field is required");

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
