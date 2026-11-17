import { audioMimeTypeByFormat, readWavPcm, silencePcm, wrapPcmS16leAsWav } from "./tts.helper";
import { applyEmotionPrefix, applyLaughterTags, type DeliveryPart } from "./tts.emotion";
import { observeGpuCall } from "../observability/observability.provider";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_TEMPERATURE = 0.8;
const DEFAULT_TOP_K = 50;

type TtsModelInput = {
  text: string;
  language: string;
  voiceMode: "default" | "clone";
  voiceId?: string;
  seed?: number;
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
    /** Set when the model server is busy and said how long to wait (its Retry-After). */
    public readonly retryAfterMs?: number,
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

const observedTtsFetch = (
  endpoint: string,
  init: RequestInit,
  operation: string,
  metadata: Record<string, unknown> = {},
) => observeGpuCall<Response>({
  service: "tts",
  operation,
  endpoint,
  requestMetadata: { method: init.method || "GET", ...metadata },
  responseMetadata: (response) => ({ status: response.status, contentType: response.headers.get("content-type"), requestId: response.headers.get("x-request-id") || response.headers.get("request-id") }),
  providerReference: (response) => response.headers.get("x-request-id") || response.headers.get("request-id") || undefined,
  isSuccess: (response) => response.ok || (operation === "health_check" && response.status === 405),
  upstreamStatus: (response) => response.status,
}, () => fetch(endpoint, init));

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
    response = await observedTtsFetch(endpoint, {
      method: configuredHealthEndpoint ? "GET" : "OPTIONS",
      headers: buildModelHeaders(),
      signal: AbortSignal.timeout(
        positiveIntegerFromEnvironment("TTS_MODEL_HEALTH_TIMEOUT_MS", 10_000),
      ),
    }, "health_check");
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
    input: applyLaughterTags(applyEmotionPrefix(input.text, input.emotion)),
    stream,
    temperature: floatFromEnvironment("TTS_MODEL_TEMPERATURE", DEFAULT_TEMPERATURE),
    top_k: positiveIntegerFromEnvironment("TTS_MODEL_TOP_K", DEFAULT_TOP_K),
  };

  // Clone voices always send their sample; default voices send one too when a multi-part text
  // anchors every part to the same voice (the preset's preview clip).
  if (input.referenceAudioBase64) {
    body.reference = {
      audio_base64: input.referenceAudioBase64,
      text: input.referenceText ?? "",
    };
  }

  if (input.voiceMode === "default" && Number.isInteger(input.seed)) {
    body.seed = input.seed;
  }

  return body;
};

const parseUpstreamError = async (response: Response) => {
  const responseText = (await response.text()).slice(0, 500);
  console.error("TTS model request failed", response.status, responseText);

  // The GPU gateway answers 503 "busy" (all slots taken) or 429 (per-client limit) with Retry-After.
  if (response.status === 503 || response.status === 429) {
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    throw new TtsModelError(
      "Text-to-speech is busy right now. Please try again in a moment.",
      "model_busy",
      503,
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 2000,
    );
  }

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
    response = await observedTtsFetch(endpoint, {
      method: "POST",
      headers: buildModelHeaders(),
      body: JSON.stringify(buildSpeechRequestBody(input, true)),
      signal: AbortSignal.timeout(
        positiveIntegerFromEnvironment("TTS_MODEL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
      ),
    }, "stream_synthesis", { textCharacters: input.text.length, language: input.language, voiceMode: input.voiceMode, outputFormat: input.outputFormat });
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
    response = await observedTtsFetch(endpoint, {
      method: "POST",
      headers: buildModelHeaders(),
      body: JSON.stringify(buildSpeechRequestBody(input, false)),
      signal: AbortSignal.timeout(
        positiveIntegerFromEnvironment("TTS_MODEL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
      ),
    }, "synthesis", { textCharacters: input.text.length, language: input.language, voiceMode: input.voiceMode, outputFormat: input.outputFormat });
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

/* ------------------------------------------------------------------------------------------------
 * Multi-part synthesis: a text whose delivery changes midway (see splitIntoDeliveryParts) is
 * spoken as one model request per part, every part with the same voice sample, and the parts are
 * joined with a short pause. At most two requests per generation run at a time, which keeps a
 * generation well inside the GPU gateway's limit of concurrent requests.
 * ---------------------------------------------------------------------------------------------- */

/** Everything about a request except the words: shared by all parts of one generation. */
export type TtsPartsBase = Omit<TtsModelInput, "text" | "emotion">;

const BUSY_RETRIES = 3;

export const ttsPartGapMs = () => {
  const value = Number(process.env.TTS_PART_GAP_MS);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 2000) : 150;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries a model call that failed only because the GPU gateway was busy. */
const withBusyRetry = async <T>(call: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof TtsModelError) || error.code !== "model_busy" || attempt >= BUSY_RETRIES) {
        throw error;
      }
      await sleep(error.retryAfterMs ?? 2000);
    }
  }
};

const partModelInput = (base: TtsPartsBase, part: DeliveryPart): TtsModelInput => ({
  ...base,
  text: `${part.delivery}${part.text}`,
  emotion: null,
});

const joinFailure = (detail: string) =>
  new TtsModelError(`The TTS model returned audio that could not be joined: ${detail}`, "invalid_model_response", 502);

/** Speaks each part (two at a time) and joins them into one WAV. */
export const synthesizeParts = async (
  base: TtsPartsBase,
  parts: DeliveryPart[],
): Promise<TtsModelOutput> => {
  const outputs: TtsModelOutput[] = new Array(parts.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < parts.length) {
      const index = next++;
      try {
        outputs[index] = await withBusyRetry(() => synthesizeWithTtsModel(partModelInput(base, parts[index]!)));
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, parts.length) }, worker));

  const decoded = outputs.map((output, index) => {
    try {
      return readWavPcm(output.audio);
    } catch (error) {
      throw joinFailure(`part ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const { sampleRate, channels } = decoded[0]!;
  if (decoded.some((part) => part.sampleRate !== sampleRate || part.channels !== channels)) {
    throw joinFailure("the parts have different sample rates or channel counts");
  }
  const gap = silencePcm(ttsPartGapMs(), sampleRate, channels);
  const pcm = Buffer.concat(decoded.flatMap((part, index) => (index ? [gap, part.pcm] : [part.pcm])));
  const providerRequestId = outputs[0]?.providerRequestId;
  return {
    audio: wrapPcmS16leAsWav(pcm, sampleRate, channels),
    mimeType: "audio/wav",
    ...(providerRequestId ? { providerRequestId } : {}),
  };
};

/**
 * One continuous PCM stream for a multi-part text: plays part 1 as it arrives, then a short pause,
 * then part 2, and so on. The next part's request is opened while the current part is still
 * streaming, so it is usually ready by the time it is needed. A failure in any part errors the
 * stream, which the controller turns into a failed generation.
 */
export const openTtsPartsStream = async (
  base: TtsPartsBase,
  parts: DeliveryPart[],
): Promise<TtsModelStream> => {
  const open = (index: number) => {
    const opening = withBusyRetry(() => openTtsModelStream(partModelInput(base, parts[index]!)));
    opening.catch(() => undefined); // surfaced when awaited; avoids an unhandled rejection meanwhile
    return opening;
  };

  // Part 1 is awaited here, so a model that is down fails before any audio is sent.
  const first = await open(0);
  let upcoming: Promise<TtsModelStream> | null = parts.length > 1 ? open(1) : null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const gap = new Uint8Array(silencePcm(ttsPartGapMs(), first.sampleRate, first.channels));

  async function* audio(): AsyncGenerator<Uint8Array> {
    let current = first;
    for (let index = 0; ; index += 1) {
      reader = current.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) yield value;
      }
      reader.releaseLock();
      reader = null;
      if (index + 1 >= parts.length) return;

      const nextStream = await upcoming!;
      upcoming = index + 2 < parts.length ? open(index + 2) : null;
      if (nextStream.sampleRate !== first.sampleRate || nextStream.channels !== first.channels) {
        await nextStream.body.cancel().catch(() => undefined);
        throw joinFailure("the parts have different sample rates or channel counts");
      }
      if (gap.length) yield gap;
      current = nextStream;
    }
  }

  const chunks = audio();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await reader?.cancel().catch(() => undefined);
      await upcoming?.then((stream) => stream.body.cancel()).catch(() => undefined);
      await chunks.return(undefined).catch(() => undefined);
    },
  });

  return { ...first, body };
};
