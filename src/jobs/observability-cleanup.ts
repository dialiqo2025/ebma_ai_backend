import { cleanupExpiredObservabilityLogs } from "../services/observability/observability.provider";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export const startObservabilityCleanup = () => {
  const run = () => cleanupExpiredObservabilityLogs()
    .catch((error) => console.error("Scheduled monitoring cleanup failed:", error));
  const initial = setTimeout(run, 30_000);
  initial.unref();
  const interval = setInterval(run, CLEANUP_INTERVAL_MS);
  interval.unref();
};
