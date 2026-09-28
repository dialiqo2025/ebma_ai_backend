import { STT_LANGUAGES } from "../stt/stt.helper";
import type { ChatMessage } from "./chat.validate";

const DETECTABLE_LANGUAGES = STT_LANGUAGES.filter((language) => language.code !== "auto");
const DETECTABLE_CODES = new Set<string>(DETECTABLE_LANGUAGES.map((language) => language.code));

export const chatLanguageName = (code: string) =>
  STT_LANGUAGES.find((language) => language.code === code)?.name ?? code;

const describeLanguage = (code: string) => `${chatLanguageName(code)} (code "${code}")`;

const replyLanguageRule = ({ language, replyLanguage }: Pick<ChatMessage, "language" | "replyLanguage">) => {
  if (replyLanguage !== "auto") {
    return `Always reply in ${describeLanguage(replyLanguage)}, whatever language the user writes in.`;
  }

  if (language !== "auto") {
    return `The user is speaking ${describeLanguage(language)}. Reply in that same language unless the user explicitly asks you to switch languages.`;
  }

  return "Detect the language of the user's latest message and reply in that same language unless the user explicitly asks you to switch languages.";
};

export const buildChatSystemPrompt = (input: Pick<ChatMessage, "language" | "replyLanguage" | "source">) => {
  const codes = DETECTABLE_LANGUAGES.map((language) => `${language.code}=${language.name}`).join(", ");

  return [
    "You are EBMA Assistant, a friendly and knowledgeable voice assistant.",
    "Every reply you write is shown in a chat window and also read aloud by a text-to-speech engine.",
    "",
    "Rules:",
    `- ${replyLanguageRule(input)}`,
    "- Write Indian languages in their native script (for example Devanagari for Hindi and Marathi, Tamil script for Tamil). Keep brand names and technical terms that people normally say in English as they are.",
    "- Be concise and conversational: usually one to three short sentences. Go longer only when the user asks for detail, and never exceed about 150 words.",
    "- Do not use markdown, bullet symbols, tables, emojis, URLs or code blocks. Write numbers, dates and units the way they should be spoken.",
    input.source === "voice"
      ? "- The user's message came from speech recognition and may contain recognition mistakes or missing punctuation. Infer what they most likely meant; ask a short clarifying question only if the meaning is genuinely unclear."
      : "- The user typed this message.",
    "- If you do not know something, say so briefly instead of guessing.",
    "",
    'Respond with only a JSON object of the form {"reply": "<your answer>", "language": "<code>"}.',
    `"language" is the code of the language your reply is written in, chosen from: ${codes}.`,
  ].join("\n");
};

const stripCodeFence = (text: string) =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

/** Removes markdown and symbols that a TTS engine would read out literally. */
export const cleanSpokenReply = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#`>~|]+/g, " ")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

export const parseChatCompletion = (rawText: string) => {
  const body = stripCodeFence(rawText);

  let reply: string | undefined;
  let language: string | undefined;

  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.reply === "string") reply = parsed.reply;
      if (typeof parsed.language === "string") language = parsed.language.trim().toLowerCase();
    }
  } catch {
    // The model ignored the JSON instruction; treat the whole output as the reply.
  }

  return {
    text: cleanSpokenReply(reply ?? body),
    language: language && DETECTABLE_CODES.has(language) ? language : undefined,
  };
};
