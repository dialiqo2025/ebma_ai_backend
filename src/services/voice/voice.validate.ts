import { z } from "zod";
import { TTS_VOICE_PRESET_IDS } from "../tts/tts.voice-presets";
import { VOICE_LANGUAGE_CODES } from "./voice.helper";

const languageValidator = z.enum(VOICE_LANGUAGE_CODES as [string, ...string[]]);

export const createVoiceSessionValidator = z
  .object({
    /** Language the user speaks (ASR language); "auto" lets the ASR detect it. */
    language: languageValidator.default("auto"),
    /** Language the assistant answers in; "auto" mirrors the user. */
    replyLanguage: languageValidator.default("auto"),
    sttMode: z.enum(["native", "mixed", "romanized"]).default("native"),
    /** Pause that ends a phrase (server-side endpointing). */
    endSilenceMs: z.number().int().min(300).max(2000).default(600),
    voice: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("preset"), id: z.enum(TTS_VOICE_PRESET_IDS) }).strict(),
        z.object({ type: z.literal("clone"), voiceUuid: z.string().uuid() }).strict(),
      ])
      .default({ type: "preset", id: "violet" }),
    /** Spoken first sentence; empty string disables the greeting. */
    greeting: z.string().trim().max(300).optional(),
  })
  .strict();

export const voiceRoomNameValidator = z.string().regex(/^ebma-va-[0-9a-f-]{36}$/, "Invalid voice session");

export type CreateVoiceSession = z.infer<typeof createVoiceSessionValidator>;
