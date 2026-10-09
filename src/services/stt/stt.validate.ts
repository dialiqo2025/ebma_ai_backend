import { z } from "zod";

export const STT_LANGUAGE_CODES = [
  "auto",
  "hi",
  "bn",
  "ta",
  "te",
  "mr",
  "gu",
  "kn",
  "ml",
  "pa",
  "or",
  "ur",
  "as",
  "ne",
  "sa",
  "sd",
  "ks",
  "kok",
  "mai",
  "doi",
  "brx",
  "mni",
  "sat",
  "bho",
  "hne",
  "bgc",
  "bhb",
  "en",
] as const;

export const STT_OUTPUT_MODES = ["native", "mixed", "romanized"] as const;

const languageValidator = z.enum(STT_LANGUAGE_CODES);
const outputModeValidator = z.enum(STT_OUTPUT_MODES);

const sessionFields = {
  language: languageValidator.default("hi"),
  mode: outputModeValidator.default("native"),
  sampleRate: z.number().int().min(8000).max(96000).default(16000),
  endSilenceMs: z.number().int().min(250).max(3000).default(400),
  partials: z.boolean().default(true),
};

export const createSttSessionValidator = z.object(sessionFields).strict();

export const updateSttSessionValidator = z
  .object({
    language: languageValidator.optional(),
    mode: outputModeValidator.optional(),
    sampleRate: z.number().int().min(8000).max(96000).optional(),
    endSilenceMs: z.number().int().min(250).max(3000).optional(),
    partials: z.boolean().optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, "At least one field is required");

export const sttSessionUuidValidator = z.string().uuid("Invalid session UUID");

export const listSttSessionsValidator = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(10),
  status: z
    .enum(["created", "connecting", "streaming", "completed", "failed"])
    .optional(),
  language: languageValidator.optional(),
  search: z.string().trim().max(100).optional(),
});

export const sttTokenRequestValidator = z
  .object({
    ttlSeconds: z.number().int().min(10).max(900).default(300),
  })
  .strict();

export const sttFinalSegmentValidator = z
  .object({
    type: z.literal("final").optional(),
    seg: z.number().int().min(1),
    text: z.string().trim().min(1).max(20_000),
    lang: languageValidator.exclude(["auto"]),
    t0: z.number().min(0),
    t1: z.number().min(0),
    audio_s: z.number().min(0),
    decode_ms: z.number().int().min(0),
    latency_ms: z.number().int().min(0),
    reason: z.enum(["pause", "max_len", "flush"]),
  })
  .strict()
  .refine((segment) => segment.t1 >= segment.t0, {
    path: ["t1"],
    message: "t1 must be greater than or equal to t0",
  });

export const finishSttSessionValidator = z
  .object({
    status: z.enum(["completed", "failed"]).default("completed"),
    errorCode: z.string().trim().min(1).max(100).optional(),
    errorMessage: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.status === "failed" && !payload.errorCode) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "errorCode is required when status is failed",
      });
    }
  });

export type CreateSttSession = z.infer<typeof createSttSessionValidator>;
export type UpdateSttSession = z.infer<typeof updateSttSessionValidator>;
export type ListSttSessions = z.infer<typeof listSttSessionsValidator>;
export type SttTokenRequest = z.infer<typeof sttTokenRequestValidator>;
export type SttFinalSegment = z.infer<typeof sttFinalSegmentValidator>;
export type FinishSttSession = z.infer<typeof finishSttSessionValidator>;

export const createSttTranscriptionValidator = z
  .object({
    language: languageValidator.default("hi"),
    diarize: z
      .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
      .transform((value) => value === true || value === "true" || value === "1")
      .default(false),
    speakers: z.preprocess(
      (value) => (value === "" || value === undefined || value === null ? undefined : value),
      z.coerce.number().int().min(1).max(20).optional(),
    ),
  })
  .strict();

export const listSttTranscriptionsValidator = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(10),
  status: z
    .enum(["queued", "processing", "completed", "failed", "cancelled"])
    .optional(),
  language: languageValidator.optional(),
  search: z.string().trim().max(100).optional(),
});

export const sttTranscriptionUuidValidator = z.string().uuid("Invalid transcription UUID");

export const sttTranscriptionDownloadValidator = z.object({
  format: z.enum(["txt", "srt", "vtt"]).default("txt"),
});

export type CreateSttTranscription = z.infer<typeof createSttTranscriptionValidator>;
export type ListSttTranscriptions = z.infer<typeof listSttTranscriptionsValidator>;
export type SttTranscriptionDownload = z.infer<typeof sttTranscriptionDownloadValidator>;
