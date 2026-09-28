import { z } from "zod";

const tokenResponseValidator = z.object({
  token: z.string().min(1),
  expires_in: z.number().int().positive(),
  expires_at: z.number().int().positive(),
  ws_url: z.string().url().refine((url) => url.startsWith("ws://") || url.startsWith("wss://")),
});

const healthResponseValidator = z
  .object({
    status: z.literal("ok"),
    active_sessions: z.number().int().min(0).optional(),
    max_sessions: z.number().int().positive().optional(),
    queue_depth: z.number().int().min(0).optional(),
    languages: z.array(z.string()).optional(),
    modes: z.array(z.string()).optional(),
  })
  .passthrough();

export class SttModelError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "SttModelError";
  }
}

const timeoutMs = () => {
  const configured = Number(process.env.EBMA_ASR_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : 10_000;
};

const uploadTimeoutMs = () => {
  const configured = Number(process.env.EBMA_ASR_UPLOAD_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : 300_000;
};

const modelConfiguration = () => {
  const baseUrl = process.env.EBMA_ASR_BACKEND_URL?.trim().replace(/\/+$/, "");
  const apiKey = process.env.EBMA_ASR_API_KEY?.trim();

  if (!baseUrl || !apiKey) {
    throw new SttModelError(
      "EBMA ASR backend is not configured",
      "model_not_configured",
      503,
    );
  }

  return { baseUrl, apiKey };
};

const modelFetch = async (
  path: string,
  init: RequestInit,
  timeout = timeoutMs(),
) => {
  const { baseUrl, apiKey } = modelConfiguration();

  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new SttModelError(
      timedOut ? "The EBMA ASR request timed out" : "The EBMA ASR backend is unavailable",
      timedOut ? "model_timeout" : "model_unavailable",
      timedOut ? 504 : 503,
    );
  }
};

const modelErrorFromResponse = async (response: Response) => {
  let upstreamCode: string | undefined;
  let upstreamMessage: string | undefined;
  try {
    const payload = await response.json();
    upstreamCode = payload?.error?.code;
    upstreamMessage = payload?.error?.message;
  } catch {
    console.error("EBMA ASR upstream error (non-JSON):", {
      status: response.status,
      url: response.url,
    });
  }

  console.error("EBMA ASR request rejected", {
    status: response.status,
    code: upstreamCode,
    message: upstreamMessage,
  });

  if (response.status === 401) {
    return new SttModelError(
      "The EBMA ASR server credentials were rejected",
      "model_authentication_failed",
      502,
    );
  }

  if (response.status === 503 || upstreamCode === "no_api_keys") {
    return new SttModelError(
      "The EBMA ASR backend is not ready",
      "model_unavailable",
      503,
    );
  }

  if (response.status === 429) {
    return new SttModelError(
      upstreamMessage || "The EBMA ASR backend rate limit was reached",
      upstreamCode === "too_many_jobs" ? "too_many_jobs" : "model_rate_limited",
      429,
    );
  }

  if (response.status === 413) {
    return new SttModelError(
      upstreamMessage || "The uploaded file is too large for the ASR backend",
      "payload_too_large",
      413,
    );
  }

  if (response.status === 501) {
    return new SttModelError(
      upstreamMessage || "Speaker identification is not available on this ASR backend",
      "diarization_unavailable",
      501,
    );
  }

  if (response.status === 404) {
    return new SttModelError(
      upstreamMessage || "The EBMA ASR resource was not found",
      "model_not_found",
      404,
    );
  }

  if (response.status >= 500) {
    return new SttModelError(
      "The EBMA ASR backend returned a server error",
      "model_server_error",
      503,
    );
  }

  return new SttModelError(
    upstreamMessage
      ? `The EBMA ASR backend rejected the request: ${upstreamMessage}`
      : "The EBMA ASR backend rejected the request",
    upstreamCode === "bad_request" ? "invalid_model_request" : "model_request_failed",
    502,
  );
};

export const requestSttBrowserToken = async (input: {
  subject: string;
  ttlSeconds: number;
  language: string;
}) => {
  const response = await modelFetch("/v1/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: input.subject,
      ttl_seconds: input.ttlSeconds,
      ...(input.language === "auto" ? {} : { lang: input.language }),
    }),
  });

  if (!response.ok) throw await modelErrorFromResponse(response);

  try {
    return tokenResponseValidator.parse(await response.json());
  } catch {
    throw new SttModelError(
      "The EBMA ASR backend returned an invalid token response",
      "invalid_model_response",
      502,
    );
  }
};

export const getSttModelHealth = async () => {
  const response = await modelFetch("/health", { method: "GET" });
  if (!response.ok) throw await modelErrorFromResponse(response);

  try {
    return healthResponseValidator.parse(await response.json());
  } catch {
    throw new SttModelError(
      "The EBMA ASR backend returned an invalid health response",
      "invalid_model_response",
      502,
    );
  }
};

const jobCreatedValidator = z.object({
  job_id: z.string().min(1),
  status: z.string().optional(),
  status_url: z.string().optional(),
});

export type CreateTranscriptionJobInput = {
  file: Buffer;
  filename: string;
  contentType?: string;
  language: string;
  diarize: boolean;
  speakers?: number;
};

export const createTranscriptionJob = async (input: CreateTranscriptionJobInput) => {
  const query = new URLSearchParams({
    lang: input.language,
    filename: input.filename,
  });
  if (input.diarize) query.set("diarize", "1");
  if (input.speakers !== undefined) query.set("speakers", String(input.speakers));

  const response = await modelFetch(
    `/v1/transcriptions?${query.toString()}`,
    {
      method: "POST",
      headers: {
        "Content-Type": input.contentType || "application/octet-stream",
      },
      body: new Uint8Array(input.file),
    },
    uploadTimeoutMs(),
  );

  if (!response.ok) throw await modelErrorFromResponse(response);

  try {
    return jobCreatedValidator.parse(await response.json());
  } catch {
    throw new SttModelError(
      "The EBMA ASR backend returned an invalid transcription job response",
      "invalid_model_response",
      502,
    );
  }
};

export const getTranscriptionJob = async (jobId: string) => {
  const response = await modelFetch(
    `/v1/transcriptions/${encodeURIComponent(jobId)}`,
    { method: "GET" },
  );
  if (!response.ok) throw await modelErrorFromResponse(response);

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new SttModelError(
      "The EBMA ASR backend returned an invalid transcription status response",
      "invalid_model_response",
      502,
    );
  }
};

export const downloadTranscriptionJob = async (
  jobId: string,
  format: "txt" | "srt" | "vtt",
) => {
  const response = await modelFetch(
    `/v1/transcriptions/${encodeURIComponent(jobId)}?format=${format}`,
    { method: "GET" },
  );
  if (!response.ok) throw await modelErrorFromResponse(response);

  const contentType =
    response.headers.get("content-type")?.split(";")[0]?.trim() || "text/plain";
  const content = Buffer.from(await response.arrayBuffer());
  return { content, contentType, format };
};

export const deleteTranscriptionJob = async (jobId: string) => {
  const response = await modelFetch(
    `/v1/transcriptions/${encodeURIComponent(jobId)}`,
    { method: "DELETE" },
  );
  // 204 success, or 404 if already gone — treat both as ok for cleanup.
  if (response.status === 204 || response.status === 404) return;
  if (!response.ok) throw await modelErrorFromResponse(response);
};
