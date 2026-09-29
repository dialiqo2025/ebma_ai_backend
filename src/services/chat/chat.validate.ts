import { z } from "zod";
import { STT_LANGUAGE_CODES } from "../stt/stt.validate";
import { createTtsGenerationValidator } from "../tts/tts.validate";

export const CHAT_MAX_MESSAGE_CHARACTERS = 2000;
export const CHAT_MAX_HISTORY_MESSAGES = 20;
export const CHAT_MAX_HISTORY_CHARACTERS = 4000;

const languageValidator = z.enum(STT_LANGUAGE_CODES);

export const chatMessageValidator = z
  .object({
    message: z
      .string()
      .trim()
      .min(1, "Message is required")
      .max(
        CHAT_MAX_MESSAGE_CHARACTERS,
        `Message must be at most ${CHAT_MAX_MESSAGE_CHARACTERS} characters`,
      ),
    /** Language the user spoke or typed in; "auto" lets the LLM detect it. */
    language: languageValidator.default("auto"),
    /** Language the assistant should answer in; "auto" mirrors the user. */
    replyLanguage: languageValidator.default("auto"),
    source: z.enum(["voice", "text"]).default("text"),
    history: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: z.string().trim().min(1).max(CHAT_MAX_HISTORY_CHARACTERS),
          })
          .strict(),
      )
      .max(CHAT_MAX_HISTORY_MESSAGES)
      .default([]),
  })
  .strict();

// The speech endpoint takes the same fields as a TTS generation request.
export const chatSpeechValidator = createTtsGenerationValidator;

export type ChatMessage = z.infer<typeof chatMessageValidator>;
export type ChatSpeech = z.infer<typeof chatSpeechValidator>;
