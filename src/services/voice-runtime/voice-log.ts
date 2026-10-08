/**
 * Structured logs for the voice runtime. Every line is "[voice <time>] [<scope>] <event> {json}".
 * VOICE_LOG_LEVEL=debug also logs high-frequency events (ASR partials, VAD, TTS chunks, audio counters).
 */
const debugEnabled = () => (process.env.VOICE_LOG_LEVEL ?? "").toLowerCase() === "debug";

const write = (level: "log" | "warn" | "error", scope: string, event: string, data?: Record<string, unknown>) => {
  const line = `[voice ${new Date().toISOString()}] [${scope}] ${event}`;
  if (data && Object.keys(data).length) console[level](line, JSON.stringify(data));
  else console[level](line);
};

export const vlog = {
  info: (scope: string, event: string, data?: Record<string, unknown>) => write("log", scope, event, data),
  warn: (scope: string, event: string, data?: Record<string, unknown>) => write("warn", scope, event, data),
  error: (scope: string, event: string, data?: Record<string, unknown>) => write("error", scope, event, data),
  debug: (scope: string, event: string, data?: Record<string, unknown>) => {
    if (debugEnabled()) write("log", scope, event, data);
  },
};

/** Never log secrets in full. */
export const maskSecret = (value: string | null | undefined) =>
  value ? `${value.slice(0, 12)}…(${value.length})` : "";

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
