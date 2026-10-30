/**
 * EBMA ASR Arabic helpers.
 * Live mic uses short-lived ?token=; file jobs use server-side ?key=.
 * Prefer EBMA_ASR_ARABIC_WS_URL so Indic EBMA_ASR_BACKEND_URL stays unchanged.
 */

export const isArabicSttLanguage = (language: string) => language === "ar";

export const asrBaseUrlFromEnv = () =>
  (process.env.EBMA_ASR_BACKEND_URL || "").trim().replace(/\/+$/, "");

const asrApiKey = () => (process.env.EBMA_ASR_API_KEY || "").trim();

export const arabicWsBaseFromHttp = (httpBase: string) => {
  const trimmed = httpBase.replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  return trimmed.replace(/^http/, "ws");
};

/** Strip query/hash and trailing slash from a WS or HTTP URL. */
const stripUrl = (value: string) =>
  value.trim().replace(/[#?].*$/, "").replace(/\/+$/, "");

/**
 * Dedicated Arabic WebSocket base, e.g. wss://gpu…/ar/ws
 * Falls back to deriving from EBMA_ASR_BACKEND_URL only if the dedicated var is empty.
 */
export const arabicWsUrlFromEnv = () => {
  const dedicated = stripUrl(process.env.EBMA_ASR_ARABIC_WS_URL || "");
  if (dedicated) return dedicated;

  const httpBase = asrBaseUrlFromEnv();
  if (!httpBase) return "";
  return `${arabicWsBaseFromHttp(httpBase)}/ar/ws`;
};

/** HTTP health URL for Arabic — optional override, else derived from WS URL. */
export const arabicHealthUrlFromEnv = () => {
  const dedicated = stripUrl(process.env.EBMA_ASR_ARABIC_HEALTH_URL || "");
  if (dedicated) return dedicated;

  const ws = arabicWsUrlFromEnv();
  if (!ws) return "";
  const http = ws.startsWith("wss://")
    ? `https://${ws.slice("wss://".length)}`
    : ws.startsWith("ws://")
      ? `http://${ws.slice("ws://".length)}`
      : ws;
  return http.replace(/\/ar\/ws$/i, "/ar/health");
};

/** Browser live session: base URL without query (frontend appends ?token=). */
export const buildArabicWsUrlBase = () => {
  const base = arabicWsUrlFromEnv();
  if (!base) {
    throw new Error("EBMA_ASR_ARABIC_WS_URL (or EBMA_ASR_BACKEND_URL) is not configured");
  }
  return base;
};

/** Browser live session with token query. */
export const buildArabicWsUrl = (token: string) =>
  `${buildArabicWsUrlBase()}?token=${encodeURIComponent(token)}`;

/** Server-side file job: same WS path with API key (never send this to the browser). */
export const buildArabicFileWsUrl = () => {
  const base = arabicWsUrlFromEnv();
  const apiKey = asrApiKey();
  if (!base || !apiKey) {
    throw new Error(
      "EBMA_ASR_ARABIC_WS_URL and EBMA_ASR_API_KEY are required for Arabic file transcription",
    );
  }
  return `${base}?key=${encodeURIComponent(apiKey)}`;
};

export type ArabicAvailability = {
  available: boolean;
  statusCode: number;
  reason: string | null;
};

/** Server-side only — /ar/health is not CORS-friendly for browsers. */
export const checkArabicAvailability = async (): Promise<ArabicAvailability> => {
  const healthUrl = arabicHealthUrlFromEnv();
  const apiKey = asrApiKey();
  if (!healthUrl || !apiKey) {
    return {
      available: false,
      statusCode: 503,
      reason: "Arabic transcription is currently unavailable.",
    };
  }

  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 200) {
      return { available: true, statusCode: 200, reason: null };
    }

    return {
      available: false,
      statusCode: response.status,
      reason: "Arabic transcription is currently unavailable.",
    };
  } catch {
    return {
      available: false,
      statusCode: 503,
      reason: "Arabic transcription is currently unavailable.",
    };
  }
};
