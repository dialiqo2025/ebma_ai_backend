import { audioMimeTypeByFormat } from "./tts.helper";
import { applyEmotionPrefix } from "./tts.emotion";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_TEMPERATURE = 0.8;
const DEFAULT_TOP_K = 50;

type TtsModelInput = {
  text: string;
  language: string;
  voiceMode: "default" | "clone";
  voiceId?: string;
  /** Applied as `<|emotion:NAME|>` prefix on `input` for the GPU model. */
  emotion?: string | null;
  /** Clone reference audio (raw base64, no data-URL prefix) → GPU `reference.audio_base64`. */
  referenceAudioBase64?: string;
  /** Optional transcript of the reference clip → GPU `reference.text`. */
  referenceText?: string;
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

/**
 * Check whether the configured TTS processor is reachable without generating
 * billable audio. An explicit health URL is preferred; otherwise OPTIONS on
 * the synthesis endpoint is used as a lightweight reachability probe. A 405
 * from that fallback still proves that the GPU application is running.
 */
export const getTtsModelHealth = async () => {
  const modelEndpoint = process.env.TTS_MODEL_ENDPOINT?.trim();
  if (!modelEndpoint) {
    throw new TtsModelError(
      "Text-to-speech processing is not configured",
      "model_not_configured",
      503,
    );
  }

  const configuredHealthEndpoint = process.env.TTS_MODEL_HEALTH_ENDPOINT?.trim();
  const endpoint = configuredHealthEndpoint || modelEndpoint;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: configuredHealthEndpoint ? "GET" : "OPTIONS",
      headers: buildModelHeaders(),
      signal: AbortSignal.timeout(
        positiveIntegerFromEnvironment("TTS_MODEL_HEALTH_TIMEOUT_MS", 10_000),
      ),
    });
  } catch {
    throw new TtsModelError(
      "Text-to-speech processing is temporarily unavailable. Please try again later or contact your administrator.",
      "model_unavailable",
      503,
    );
  }

  const fallbackProbeIsReachable =
    !configuredHealthEndpoint &&
    response.status < 500 &&
    ![401, 403, 404].includes(response.status);

  if (!response.ok && !fallbackProbeIsReachable) {
    console.error("TTS model health check failed", {
      status: response.status,
      url: endpoint,
    });
    throw new TtsModelError(
      "Text-to-speech processing is temporarily unavailable. Please try again later or contact your administrator.",
      "model_unavailable",
      503,
    );
  }

  return { status: "ok" as const };
};

/**
 * Payload for GPU `POST /tts/v1/audio/speech`.
 * Clone curl shape:
 * `{ input, stream, temperature, top_k, reference: { audio_base64, text } }`
 */
const buildSpeechRequestBody = (input: TtsModelInput, stream: boolean) => {
  const body: Record<string, unknown> = {
    input: applyEmotionPrefix(input.text, input.emotion),
    stream,
    temperature: floatFromEnvironment("TTS_MODEL_TEMPERATURE", DEFAULT_TEMPERATURE),
    top_k: positiveIntegerFromEnvironment("TTS_MODEL_TOP_K", DEFAULT_TOP_K),
  };

  if (input.voiceMode === "clone" && input.referenceAudioBase64) {
    body.reference = {
      audio_base64: input.referenceAudioBase64,
      text: input.referenceText ?? "",
    };
  }

  return body;
};

const parseUpstreamError = async (response: Response) => {
  const responseText = (await response.text()).slice(0, 500);
  console.error("TTS model request failed", response.status, responseText);

  // A stopped GPU or a misrouted GPU service commonly responds with its own
  // plain-text 404/405 page. Keep those infrastructure details in server logs,
  // but expose a stable service-availability error to API consumers.
  if (response.status === 404 || response.status === 405) {
    throw new TtsModelError(
      "Text-to-speech processing is temporarily unavailable. Please try again later or contact your administrator.",
      "model_unavailable",
      503,
    );
  }

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
    response.status === 401 || response.status === 403
      ? " (authentication failed — check TTS_MODEL_API_KEY)"
      : "";

  throw new TtsModelError(
    detail
      ? `The TTS model could not generate audio: ${detail}${hint}`
      : `The TTS model could not generate audio (HTTP ${response.status})${hint}`,
    "model_request_failed",
    response.status >= 500 ? 502 : 422,
  );
};

const resolveStreamSampleRate = (response: Response) => {
  const header =
    response.headers.get("x-audio-sample-rate") ||
    response.headers.get("x-sample-rate") ||
    response.headers.get("sample-rate");
  const fromHeader = header ? Number(header) : NaN;
  if (Number.isInteger(fromHeader) && fromHeader > 0) return fromHeader;

  const env = Number(process.env.TTS_STREAM_SAMPLE_RATE);
  return Number.isInteger(env) && env > 0 ? env : 24_000;
};

export type TtsModelStream = {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  sampleRate: number;
  channels: number;
  encoding: "pcm_s16le";
  providerRequestId?: string;
};

/** Open a streaming synthesis request (`stream: true` → typically raw PCM). */
export const openTtsModelStream = async (
  input: TtsModelInput,
): Promise<TtsModelStream> => {
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
      body: JSON.stringify(buildSpeechRequestBody(input, true)),
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

  if (!response.ok) await parseUpstreamError(response);
  if (!response.body) {
    throw new TtsModelError(
      "The TTS model returned an empty stream",
      "invalid_model_response",
      502,
    );
  }

  const contentType =
    response.headers.get("content-type")?.split(";")[0]?.trim() || "audio/pcm";
  const providerRequestId =
    response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
  const channelsEnv = Number(process.env.TTS_STREAM_CHANNELS);
  const channels = Number.isInteger(channelsEnv) && channelsEnv > 0 ? channelsEnv : 1;

  return {
    body: response.body,
    contentType,
    sampleRate: resolveStreamSampleRate(response),
    channels,
    encoding: "pcm_s16le",
    ...(providerRequestId ? { providerRequestId } : {}),
  };
};

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
      body: JSON.stringify(buildSpeechRequestBody(input, false)),
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

  if (!response.ok) await parseUpstreamError(response);

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
