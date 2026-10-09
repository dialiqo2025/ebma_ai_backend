export type PlaygroundApi = "tts" | "stt";

const positiveIntegerFromEnvironment = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

export const playgroundTrialLimit = () =>
  positiveIntegerFromEnvironment("PLAYGROUND_TRIAL_LIMIT", 5);

export const playgroundTtsMaxChars = () =>
  positiveIntegerFromEnvironment("PLAYGROUND_TTS_MAX_CHARS", 200);

export const playgroundSttMaxBytes = () =>
  positiveIntegerFromEnvironment("PLAYGROUND_STT_MAX_BYTES", 1_500_000);

export const playgroundRateLimit = () =>
  positiveIntegerFromEnvironment("PLAYGROUND_RATE_LIMIT", 6);

export const playgroundRateWindowSeconds = () =>
  positiveIntegerFromEnvironment("PLAYGROUND_RATE_WINDOW_SECONDS", 60);

export const playgroundMinIntervalMs = () =>
  positiveIntegerFromEnvironment("PLAYGROUND_MIN_INTERVAL_MS", 5_000);

export const playgroundGlobalConcurrency = () =>
  positiveIntegerFromEnvironment("PLAYGROUND_GLOBAL_CONCURRENCY", 2);

export const playgroundSttPollTimeoutMs = () =>
  positiveIntegerFromEnvironment("PLAYGROUND_STT_POLL_TIMEOUT_MS", 90_000);

export const playgroundSttPollIntervalMs = () =>
  positiveIntegerFromEnvironment("PLAYGROUND_STT_POLL_INTERVAL_MS", 1_500);

export const playgroundPortalLoginUrl = () =>
  (process.env.PLAYGROUND_PORTAL_LOGIN_URL || process.env.PORTAL_URL || "http://localhost:3000")
    .replace(/\/$/, "") + "/";

export const playgroundAllowedOrigins = (): Set<string> => {
  const raw = [
    process.env.PLAYGROUND_ALLOWED_ORIGINS,
    process.env.SITE_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    "http://localhost:3001",
    "http://127.0.0.1:3001",
  ]
    .filter(Boolean)
    .join(",");

  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
};
