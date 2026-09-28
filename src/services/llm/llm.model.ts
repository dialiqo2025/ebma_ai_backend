export type LlmStyle = "natural" | "formal" | "brief";

export type LlmRequestInput = {
  text: string;
  language: string;
  style?: LlmStyle;
  systemPrompt?: string;
};

export type LlmModelOutput = {
  text: string;
  providerRequestId?: string;
};

export class LlmModelError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "LlmModelError";
  }
}

export const normalizeLlmText = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.,!?;:])(?=\S)/g, "$1 ")
    .trim();

export const isLlmConfigured = () => {
  const endpoint = process.env.LLM_MODEL_ENDPOINT?.trim();
  const apiKey = process.env.LLM_API_KEY?.trim();
  return Boolean(endpoint && apiKey);
};

export const buildLlmPrompt = ({
  text,
  language,
  style = "natural",
  systemPrompt,
}: LlmRequestInput) => {
  const cleanedText = normalizeLlmText(text);

  return `
    ${systemPrompt ?? "Rewrite the transcript for clear spoken output."}

    Requirements:
    - Language: ${language}
    - Style: ${style}
    - Keep the meaning accurate.
    - Remove filler words, repeated phrases, and obvious speech noise.
    - Keep it natural for spoken TTS.
    - Return only the final polished text, without markdown or commentary.

    Transcript:
    "${cleanedText}"
  `.trim();
};

const buildModelHeaders = () => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const apiKey = process.env.LLM_API_KEY?.trim();
  const apiKeyHeader = process.env.LLM_API_KEY_HEADER?.trim() || "Authorization";
  const rawPrefix = process.env.LLM_API_KEY_PREFIX;
  const apiKeyPrefix = rawPrefix === undefined ? "Bearer" : rawPrefix.trim();

  if (apiKey) {
    const value = apiKeyPrefix ? `${apiKeyPrefix} ${apiKey}` : apiKey;
    headers[apiKeyHeader] = value;
  }

  return headers;
};

const extractLlmText = (payload: any): string | undefined => {
  const candidate =
    payload?.output_text ??
    payload?.outputText ??
    payload?.text ??
    payload?.content ??
    payload?.choices?.[0]?.message?.content ??
    payload?.choices?.[0]?.text ??
    payload?.result ??
    payload?.data?.text ??
    payload?.data?.output_text ??
    payload?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text).filter(Boolean).join(" ") ??
    payload?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof candidate === "string") return candidate;

  if (Array.isArray(candidate)) {
    const joined = candidate
      .map((part) => (typeof part === "string" ? part : part?.text))
      .filter(Boolean)
      .join(" ");

    if (joined.trim()) return joined.trim();
  }

  return undefined;
};

export type LlmTurn = {
  role: "user" | "assistant";
  text: string;
};

export type LlmCompletionInput = {
  system: string;
  turns: LlmTurn[];
  temperature?: number;
  /** Ask the model for a JSON object (Gemini enforces it; others follow the prompt). */
  json?: boolean;
};

export type LlmCompletionOutput = {
  rawText: string;
  providerRequestId?: string;
};

const buildGeminiBody = (input: LlmCompletionInput) => {
  const thinkingBudget = Number(process.env.LLM_THINKING_BUDGET);

  return {
    systemInstruction: { parts: [{ text: input.system }] },
    contents: input.turns.map((turn) => ({
      role: turn.role === "assistant" ? "model" : "user",
      parts: [{ text: turn.text }],
    })),
    generationConfig: {
      temperature: input.temperature ?? 0.2,
      ...(input.json ? { responseMimeType: "application/json" } : {}),
      ...(Number.isInteger(thinkingBudget) && thinkingBudget >= 0
        ? { thinkingConfig: { thinkingBudget } }
        : {}),
    },
  };
};

const buildChatCompletionsBody = (input: LlmCompletionInput, modelName: string) => ({
  model: modelName,
  messages: [
    { role: "system", content: input.system },
    ...input.turns.map((turn) => ({ role: turn.role, content: turn.text })),
  ],
  temperature: input.temperature ?? 0.2,
});

export const requestLlmCompletion = async (
  input: LlmCompletionInput,
): Promise<LlmCompletionOutput> => {
  const endpoint = process.env.LLM_MODEL_ENDPOINT?.trim();
  if (!endpoint) {
    throw new LlmModelError(
      "LLM model endpoint is not configured",
      "model_not_configured",
      503,
    );
  }

  const modelName = process.env.LLM_MODEL?.trim() || "gpt-4o-mini";
  const isGemini = endpoint.includes("generativelanguage.googleapis.com") || modelName.startsWith("gemini-");
  const apiKey = process.env.LLM_API_KEY?.trim();
  const finalEndpoint = isGemini && apiKey && !endpoint.includes("key=")
    ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`
    : endpoint;

  let response: Response;
  try {
    response = await fetch(finalEndpoint, {
      method: "POST",
      headers: buildModelHeaders(),
      body: JSON.stringify(
        isGemini ? buildGeminiBody(input) : buildChatCompletionsBody(input, modelName),
      ),
      signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 30_000)),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new LlmModelError(
      timedOut ? "The LLM request timed out" : "The LLM model is unavailable",
      timedOut ? "model_timeout" : "model_unavailable",
      timedOut ? 504 : 503,
    );
  }

  if (!response.ok) {
    const responseText = (await response.text()).slice(0, 500);
    console.error("LLM model request failed", response.status, responseText);
    throw new LlmModelError(
      response.status === 429
        ? "The LLM model rate limit was reached"
        : "The LLM model could not process the request",
      response.status === 429
        ? "model_rate_limited"
        : response.status >= 500
          ? "model_request_failed"
          : "invalid_model_request",
      response.status === 429 ? 429 : response.status >= 500 ? 502 : 422,
    );
  }

  let payload: any;
  try {
    payload = await response.json();
  } catch {
    throw new LlmModelError(
      "The LLM model returned an unsupported response",
      "invalid_model_response",
      502,
    );
  }

  const extractedText = extractLlmText(payload);
  if (!extractedText?.trim()) {
    throw new LlmModelError(
      "The LLM model response did not contain text",
      "invalid_model_response",
      502,
    );
  }

  const providerRequestId =
    response.headers.get("x-request-id") ??
    response.headers.get("request-id") ??
    payload?.responseId ??
    payload?.id ??
    undefined;

  return {
    rawText: extractedText,
    ...(providerRequestId ? { providerRequestId } : {}),
  };
};

export const transformWithLlm = async (input: LlmRequestInput): Promise<LlmModelOutput> => {
  const completion = await requestLlmCompletion({
    system: "You are a transcript cleanup assistant for speech synthesis.",
    turns: [{ role: "user", text: buildLlmPrompt(input) }],
    temperature: 0.2,
  });

  const finalText = normalizeLlmText(completion.rawText);

  if (!finalText) {
    throw new LlmModelError(
      "The LLM model returned empty text",
      "invalid_model_response",
      502,
    );
  }

  return {
    text: finalText,
    ...(completion.providerRequestId
      ? { providerRequestId: completion.providerRequestId }
      : {}),
  };
};
