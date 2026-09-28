import { audioMimeTypeByFormat } from "./tts.helper";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_TEMPERATURE = 0.8;
const DEFAULT_TOP_K = 50;

type TtsModelInput = {
  text: string;
  language: string;
  voiceMode: "default" | "clone";
  voiceId?: string;
  speed: number;
  pitch: number;
  outputFormat: "wav" | "mp3" | "ogg";
};

export type TtsModelOutput = {
  audio: Buffer;
  mimeType: string;
  providerRequestId?: string;
};

export class TtsModelError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "TtsModelError";
  }
}

const positiveIntegerFromEnvironment = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const floatFromEnvironment = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const extractBase64Audio = (payload: any): string | undefined => {
  const candidate =
    payload?.audio_base64 ??
    payload?.audioBase64 ??
    payload?.audio ??
    payload?.audios?.[0] ??
    payload?.data?.audio_base64 ??
    payload?.data?.audioBase64 ??
    payload?.data?.audio;

  return typeof candidate === "string" ? candidate : undefined;
};

const decodeBase64Audio = (value: string) => {
  const match = value.match(/^data:([^;]+);base64,(.+)$/s);
  const encoded = match?.[2] ?? value;

  if (!/^[A-Za-z0-9+/\s]*={0,2}$/.test(encoded)) {
    throw new TtsModelError(
      "The TTS model returned an invalid base64 audio value",
      "invalid_model_response",
      502,
    );
  }

  return {
    audio: Buffer.from(encoded, "base64"),
    embeddedMimeType: match?.[1],
  };
};

const buildModelHeaders = () => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "audio/*, application/json",
  };

  const apiKey = process.env.TTS_MODEL_API_KEY?.trim();
  if (apiKey) {
    const headerName = process.env.TTS_MODEL_API_KEY_HEADER?.trim() || "Authorization";
    const prefix = process.env.TTS_MODEL_API_KEY_PREFIX ?? "Bearer";
    headers[headerName] = prefix.trim() ? `${prefix.trim()} ${apiKey}` : apiKey;
  }

  return headers;
};

/** Payload for EBMA TTS `POST /tts/v1/audio/speech` (OpenAI-style speech API). */
const buildSpeechRequestBody = (input: TtsModelInput) => ({
  input: input.text,
  // Non-streaming returns a complete audio/wav body, which we store on disk.
  stream: false,
  temperature: floatFromEnvironment("TTS_MODEL_TEMPERATURE", DEFAULT_TEMPERATURE),
  top_k: positiveIntegerFromEnvironment("TTS_MODEL_TOP_K", DEFAULT_TOP_K),
  language: input.language,
  voice_mode: input.voiceMode,
  ...(input.voiceId ? { voice_id: input.voiceId } : {}),
  speed: input.speed,
  pitch: input.pitch,
  output_format: input.outputFormat,
});

export const synthesizeWithTtsModel = async (
  input: TtsModelInput,
): Promise<TtsModelOutput> => {
  const endpoint = process.env.TTS_MODEL_ENDPOINT?.trim();
  if (!endpoint) {
    throw new TtsModelError(
      "TTS model endpoint is not configured",
      "model_not_configured",
      503,
    );
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: buildModelHeaders(),
      body: JSON.stringify(buildSpeechRequestBody(input)),
      signal: AbortSignal.timeout(
        positiveIntegerFromEnvironment("TTS_MODEL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
      ),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new TtsModelError(
      timedOut ? "The TTS model request timed out" : "The TTS model is unavailable",
      timedOut ? "model_timeout" : "model_unavailable",
      timedOut ? 504 : 503,
    );
  }

  if (!response.ok) {
    const responseText = (await response.text()).slice(0, 500);
    console.error("TTS model request failed", response.status, responseText);

    let detail = "";
    try {
      const payload = JSON.parse(responseText);
      detail =
        payload?.detail ||
        payload?.error?.message ||
        payload?.message ||
        "";
    } catch {
      detail = responseText.trim();
    }

    const hint =
      response.status === 404
        ? " (endpoint not found — use /tts/v1/audio/speech)"
        : response.status === 405
          ? " (method not allowed — this URL likely is not the POST synthesize route)"
          : response.status === 401 || response.status === 403
            ? " (authentication failed — check TTS_MODEL_API_KEY)"
            : "";

    throw new TtsModelError(
      detail
        ? `The TTS model could not generate audio: ${detail}${hint}`
        : `The TTS model could not generate audio (HTTP ${response.status})${hint}`,
      "model_request_failed",
      response.status >= 500 ? 502 : 422,
    );
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
  const providerRequestId =
    response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;

  let audio: Buffer;
  let mimeType = contentType || audioMimeTypeByFormat[input.outputFormat];

  if (contentType?.startsWith("audio/")) {
    audio = Buffer.from(await response.arrayBuffer());
  } else {
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new TtsModelError(
        "The TTS model returned an unsupported response",
        "invalid_model_response",
        502,
      );
    }

    const base64Audio = extractBase64Audio(payload);
    if (!base64Audio) {
      throw new TtsModelError(
        "The TTS model response did not contain audio",
        "invalid_model_response",
        502,
      );
    }

    const decoded = decodeBase64Audio(base64Audio);
    audio = decoded.audio;
    mimeType = decoded.embeddedMimeType ?? payload?.mime_type ?? payload?.mimeType ?? mimeType;
  }

  const maxAudioBytes = positiveIntegerFromEnvironment(
    "TTS_MAX_AUDIO_BYTES",
    DEFAULT_MAX_AUDIO_BYTES,
  );
  if (audio.length === 0 || audio.length > maxAudioBytes) {
    throw new TtsModelError(
      audio.length === 0
        ? "The TTS model returned empty audio"
        : "The TTS model response exceeded the configured audio size limit",
      "invalid_model_response",
      502,
    );
  }

  return {
    audio,
    mimeType,
    ...(providerRequestId ? { providerRequestId } : {}),
  };
};
