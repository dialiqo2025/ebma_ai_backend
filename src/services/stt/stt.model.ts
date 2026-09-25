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

const modelFetch = async (path: string, init: RequestInit) => {
  const { baseUrl, apiKey } = modelConfiguration();

  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs()),
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
  try {
    const payload = await response.json();
    upstreamCode = payload?.error?.code;
  } catch {
    // The public response intentionally does not expose raw upstream content.
  }

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

  return new SttModelError(
    "The EBMA ASR backend rejected the request",
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
