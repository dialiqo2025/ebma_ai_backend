import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import { isLlmConfigured, LlmModelError, requestLlmCompletion } from "../llm/llm.model";
import { STT_LANGUAGES } from "../stt/stt.helper";
import { isTtsModelConfigured } from "../tts/tts.helper";
import { synthesizeWithTtsModel, TtsModelError } from "../tts/tts.model";
import { buildChatSystemPrompt, parseChatCompletion } from "./chat.helper";
import {
  CHAT_MAX_HISTORY_MESSAGES,
  CHAT_MAX_MESSAGE_CHARACTERS,
  type ChatMessage,
  type ChatSpeech,
} from "./chat.validate";

const MAX_REPLY_CHARACTERS = 1500;

const truncateForSpeech = (text: string) => {
  if (text.length <= MAX_REPLY_CHARACTERS) return text;

  const slice = text.slice(0, MAX_REPLY_CHARACTERS);
  const lastBoundary = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("। "),
  );
  return (lastBoundary > MAX_REPLY_CHARACTERS / 2 ? slice.slice(0, lastBoundary + 1) : slice).trim();
};

export const replyToChatMessage = async (payload: ChatMessage) => {
  const startedAt = Date.now();

  try {
    const completion = await requestLlmCompletion({
      system: buildChatSystemPrompt(payload),
      turns: [
        ...payload.history,
        { role: "user", text: payload.message },
      ],
      temperature: 0.6,
      json: true,
    });

    const parsed = parseChatCompletion(completion.rawText);
    if (!parsed.text) {
      return GenResObj(Code.BAD_GATEWAY, false, "The assistant returned an empty reply", {
        code: "invalid_model_response",
      });
    }

    const replyLanguage =
      parsed.language ??
      (payload.replyLanguage !== "auto"
        ? payload.replyLanguage
        : payload.language !== "auto"
          ? payload.language
          : "auto");

    return GenResObj(Code.OK, true, "Reply generated successfully", {
      reply: {
        text: truncateForSpeech(parsed.text),
        language: replyLanguage,
      },
      llmMs: Date.now() - startedAt,
      ...(completion.providerRequestId
        ? { providerRequestId: completion.providerRequestId }
        : {}),
    });
  } catch (error) {
    const modelError =
      error instanceof LlmModelError
        ? error
        : new LlmModelError("The assistant could not reply", "processing_failed", 500);

    if (!(error instanceof LlmModelError)) {
      console.error("Unexpected chat reply error:", error);
    }

    return GenResObj(modelError.httpStatus, false, modelError.message, {
      code: modelError.code,
    });
  }
};

export const synthesizeChatSpeech = async (payload: ChatSpeech) => {
  try {
    const output = await synthesizeWithTtsModel({
      text: payload.text,
      language: payload.language,
      voiceMode: payload.voiceMode,
      ...(payload.voiceId ? { voiceId: payload.voiceId } : {}),
      speed: payload.speed,
      pitch: payload.pitch,
      outputFormat: payload.outputFormat,
    });

    return { audio: output };
  } catch (error) {
    const modelError =
      error instanceof TtsModelError
        ? error
        : new TtsModelError("Speech generation failed", "generation_failed", 500);

    if (!(error instanceof TtsModelError)) {
      console.error("Unexpected chat speech error:", error);
    }

    return {
      response: GenResObj(modelError.httpStatus, false, modelError.message, {
        code: modelError.code,
      }),
    };
  }
};

export const getChatOptions = () =>
  GenResObj(Code.OK, true, "Chat options fetched successfully", {
    languages: STT_LANGUAGES,
    llmConfigured: isLlmConfigured(),
    ttsConfigured: isTtsModelConfigured(),
    maxMessageCharacters: CHAT_MAX_MESSAGE_CHARACTERS,
    maxReplyCharacters: MAX_REPLY_CHARACTERS,
    maxHistoryMessages: CHAT_MAX_HISTORY_MESSAGES,
    voiceModes: ["default", "clone"],
    audioFormats: ["wav", "mp3", "ogg"],
    speed: { min: 0.5, max: 1.5, step: 0.1, default: 1 },
    pitch: { min: 0.5, max: 1.5, step: 0.1, default: 1 },
  });
