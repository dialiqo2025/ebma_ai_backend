import { STT_LANGUAGES } from "../stt/stt.helper";
import { replyLanguageRule } from "../chat/chat.helper";

/**
 * Languages the realtime voice agent can recognise. The agent streams to the EBMA
 * Indic ASR WebSocket, which does not cover Arabic/Urdu (those use a separate ASR).
 */
const UNSUPPORTED_REALTIME = new Set(["ar", "ur"]);
export const VOICE_LANGUAGES = STT_LANGUAGES.filter((l) => !UNSUPPORTED_REALTIME.has(l.code));
export const VOICE_LANGUAGE_CODES = VOICE_LANGUAGES.map((l) => l.code);

export const PLATFORM_LLM_LABEL = () => process.env.VOICE_PLATFORM_LLM_LABEL?.trim() || "openai/gpt-oss-120b";

/** System prompt for spoken, streamed replies (no JSON wrapper, unlike text chat). */
export const buildVoiceSystemPrompt = (input: { language: string; replyLanguage: string }) =>
  [
    "You are EBMA Assistant, a friendly and knowledgeable voice assistant from EBMA.AI by Dialiqo Technologies.",
    "You are talking with the user in a live voice call. Everything you write is spoken aloud immediately by a text-to-speech engine, and also shown as a live transcript.",
    "",
    "Rules:",
    `- ${replyLanguageRule({ language: input.language, replyLanguage: input.replyLanguage } as never)}`,
    "- Write Indian languages in their native script (for example Devanagari for Hindi and Marathi, Tamil script for Tamil). Keep brand names and technical terms that people normally say in English as they are.",
    "- Be concise and conversational: usually one to three short sentences. Go longer only when the user asks for detail.",
    "- Never use markdown, bullet symbols, tables, emojis, URLs or code blocks. Write numbers, dates and units the way they should be spoken.",
    "- The user's words come from speech recognition and may contain recognition mistakes or missing punctuation. Infer what they most likely meant; ask a short clarifying question only if the meaning is genuinely unclear.",
    "- The user can interrupt you at any time. If they do, answer their new question.",
    "- If you do not know something, say so briefly instead of guessing.",
  ].join("\n");

export const DEFAULT_GREETING: Record<string, string> = {
  hi: "नमस्ते! मैं EBMA असिस्टेंट हूँ। मैं आपकी क्या मदद कर सकता हूँ?",
  en: "Hello! I'm the EBMA assistant. How can I help you today?",
};

export const greetingFor = (language: string, replyLanguage: string) => {
  const lang = replyLanguage !== "auto" ? replyLanguage : language;
  return DEFAULT_GREETING[lang] ?? DEFAULT_GREETING.en!;
};

export type AgentLlmConfig =
  | { provider: "platform" }
  | {
      provider: "openai_compatible";
      label: string;
      base_url: string;
      api_key: string;
      model: string;
      temperature: number;
      max_tokens: number;
      top_p: number;
    };

/** OpenAI-compatible chat-completions base URL for each provider the portal supports. */
const OPENAI_COMPATIBLE_BASE: Record<string, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  claude: "https://api.anthropic.com/v1/",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
};

const normalizeCustomEndpoint = (endpoint: string) =>
  endpoint.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");

/**
 * Map the user's saved LLM settings (LLM Settings page) to what the voice agent needs.
 * Users without their own settings use the platform model configured on the agent.
 */
export const resolveAgentLlm = (row: {
  provider: string;
  model_name: string;
  endpoint: string | null;
  api_key: string;
  temperature: string | number;
  max_tokens: number;
  top_p: string | number;
} | null): AgentLlmConfig => {
  if (!row) return { provider: "platform" };
  const provider = row.provider.trim().toLowerCase();
  const base = provider === "custom" ? (row.endpoint ? normalizeCustomEndpoint(row.endpoint) : "") : OPENAI_COMPATIBLE_BASE[provider];
  if (!base) return { provider: "platform" };
  return {
    provider: "openai_compatible",
    label: `${row.provider} ${row.model_name}`,
    base_url: base,
    api_key: row.api_key || "",
    model: row.model_name,
    temperature: Math.min(2, Math.max(0, Number(row.temperature ?? 0.7))),
    // keep spoken replies short; the user's ceiling still applies when lower
    max_tokens: Math.max(64, Math.min(Number(row.max_tokens) || 512, 1024)),
    top_p: Math.min(1, Math.max(0, Number(row.top_p ?? 1))),
  };
};
