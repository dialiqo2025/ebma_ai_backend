import { z } from "zod";
import { STT_LANGUAGE_CODES } from "../stt/stt.validate";

const languageValidator = z.enum(STT_LANGUAGE_CODES);

const webhookToolValidator = z
  .object({
    name: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/, "Tool names use lowercase letters, digits and _"),
    description: z.string().trim().min(1).max(500),
    url: z.string().trim().url(),
    method: z.enum(["GET", "POST"]).default("POST"),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const botFields = {
  name: z.string().trim().min(1).max(120),
  system_prompt: z.string().trim().min(1).max(20_000),
  greeting: z.string().trim().max(1000).default(""),
  language: languageValidator.default("hi"),
  stt_mode: z.enum(["native", "mixed", "romanized"]).default("native"),
  end_silence_ms: z.number().int().min(250).max(3000).default(700),
  voice_mode: z.enum(["default", "clone"]).default("default"),
  voice_id: z.string().trim().min(1).max(255).nullable().optional(),
  speed: z.number().min(0.5).max(1.5).default(1),
  pitch: z.number().min(0.5).max(1.5).default(1),
  temperature: z.number().min(0).max(1.5).default(0.4),
  barge_in: z.boolean().default(true),
  silence_timeout_s: z.number().int().min(5).max(120).default(15),
  max_duration_s: z.number().int().min(30).max(3600).default(600),
  handoff_enabled: z.boolean().default(true),
  handoff_message: z.string().trim().max(500).default(""),
  goodbye_message: z.string().trim().max(500).default(""),
  tools: z.array(webhookToolValidator).max(10).default([]),
  enabled: z.boolean().default(true),
};

export const createVoiceBotValidator = z.object(botFields).strict();

export const updateVoiceBotValidator = z
  .object(Object.fromEntries(
    Object.entries(botFields).map(([key, schema]) => [key, (schema as z.ZodTypeAny).optional()]),
  ) as { [K in keyof typeof botFields]: z.ZodOptional<(typeof botFields)[K]> })
  .strict();

const ipValidator = z.string().trim().regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/, "Enter an IP address or CIDR");

export const createConnectionValidator = z
  .object({
    name: z.string().trim().min(1).max(120),
    allowed_ips: z.array(ipValidator).max(20).default([]),
    callback_url: z.string().trim().url().nullable().optional(),
    callback_token: z.string().trim().max(255).nullable().optional(),
    playback_mode: z.enum(["json", "binary"]).default("json"),
    sample_rate: z.union([z.literal(8000), z.literal(16000)]).default(16000),
  })
  .strict();

export const updateConnectionValidator = createConnectionValidator.partial().strict();

export const listCallsValidator = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  bot_uuid: z.string().uuid().optional(),
});

export type CreateVoiceBot = z.infer<typeof createVoiceBotValidator>;
export type UpdateVoiceBot = z.infer<typeof updateVoiceBotValidator>;
export type CreateConnection = z.infer<typeof createConnectionValidator>;
export type UpdateConnection = z.infer<typeof updateConnectionValidator>;
