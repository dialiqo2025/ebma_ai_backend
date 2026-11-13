import {
  claimAndRunScheduledGpuHealthCheck,
  cleanupGpuHealthChecks,
} from "../services/gpu-health/gpu-health.provider";

const POLL_INTERVAL_MS = 30_000;
const CLEANUP_INTERVAL_MS = 60 * 60_000;

export const startGpuHealthMonitor = () => {
  const check = () => claimAndRunScheduledGpuHealthCheck()
    .catch((error) => console.error("Scheduled GPU health check failed:", error));
  const cleanup = () => cleanupGpuHealthChecks()
    .catch((error) => console.error("Scheduled GPU health cleanup failed:", error));

  const initialCheck = setTimeout(check, 10_000);
  initialCheck.unref();
  const checkInterval = setInterval(check, POLL_INTERVAL_MS);
  checkInterval.unref();
  const initialCleanup = setTimeout(cleanup, 45_000);
  initialCleanup.unref();
  const cleanupInterval = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  cleanupInterval.unref();
};
