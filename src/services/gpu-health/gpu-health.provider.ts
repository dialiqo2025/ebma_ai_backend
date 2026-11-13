import { and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import {
  GpuHealthCheckLogs,
  GpuHealthMonitorSettings,
  GpuHealthRecipients,
} from "../../schema";
import { renderEbmaNoticeEmail, sendEmail } from "../../utils/email.util";

const SINGLETON_ID = 1;
const MAX_RESPONSE_CHARACTERS = 16_000;

const clampInteger = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

const healthTimeoutMs = () => clampInteger(process.env.TTS_MODEL_HEALTH_TIMEOUT_MS, 10_000, 1_000, 120_000);

const configuredProbe = () => {
  const modelEndpoint = process.env.TTS_MODEL_ENDPOINT?.trim();
  if (!modelEndpoint) throw Object.assign(new Error("TTS GPU endpoint is not configured"), { code: "model_not_configured" });
  const configuredHealthEndpoint = process.env.TTS_MODEL_HEALTH_ENDPOINT?.trim();
  return { endpoint: configuredHealthEndpoint || modelEndpoint, method: configuredHealthEndpoint ? "GET" : "OPTIONS" } as const;
};

const safeEndpoint = (value: string) => {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of url.searchParams.keys()) url.searchParams.set(key, "[redacted]");
    return url.toString();
  } catch {
    return value.split("?")[0] || "Configured TTS GPU endpoint";
  }
};

const modelHeaders = () => {
  const headers: Record<string, string> = { Accept: "application/json, text/plain, */*" };
  const apiKey = process.env.TTS_MODEL_API_KEY?.trim();
  if (apiKey) {
    const name = process.env.TTS_MODEL_API_KEY_HEADER?.trim() || "Authorization";
    const prefix = process.env.TTS_MODEL_API_KEY_PREFIX ?? "Bearer";
    headers[name] = prefix.trim() ? `${prefix.trim()} ${apiKey}` : apiKey;
  }
  return headers;
};

const responseText = async (response: Response) => {
  const body = await response.text().catch(() => "");
  return body.length > MAX_RESPONSE_CHARACTERS
    ? `${body.slice(0, MAX_RESPONSE_CHARACTERS)}…[truncated]`
    : body || null;
};

const ensureSettings = async () => {
  const [existing] = await db.select().from(GpuHealthMonitorSettings)
    .where(eq(GpuHealthMonitorSettings.setting_id, SINGLETON_ID)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(GpuHealthMonitorSettings)
    .values({ setting_id: SINGLETON_ID }).onConflictDoNothing().returning();
  if (created) return created;
  const [current] = await db.select().from(GpuHealthMonitorSettings)
    .where(eq(GpuHealthMonitorSettings.setting_id, SINGLETON_ID)).limit(1);
  return current!;
};

export const getGpuHealthConfiguration = async () => {
  const [settings, recipients, latest] = await Promise.all([
    ensureSettings(),
    db.select().from(GpuHealthRecipients).orderBy(GpuHealthRecipients.created_at),
    db.select().from(GpuHealthCheckLogs).orderBy(desc(GpuHealthCheckLogs.checked_at)).limit(1),
  ]);
  let endpoint = "Not configured";
  try { endpoint = safeEndpoint(configuredProbe().endpoint); } catch { /* surfaced by health checks */ }
  return { settings, recipients, latestCheck: latest[0] ?? null, endpoint };
};

export const updateGpuHealthSettings = async (input: {
  enabled: boolean;
  checkIntervalMinutes: number;
  retentionDays: number;
  notificationsEnabled: boolean;
}, userUuid: string) => {
  const nextCheckAt = new Date(Date.now() + input.checkIntervalMinutes * 60_000);
  const [settings] = await db.insert(GpuHealthMonitorSettings).values({
    setting_id: SINGLETON_ID,
    enabled: input.enabled,
    check_interval_minutes: input.checkIntervalMinutes,
    retention_days: input.retentionDays,
    notifications_enabled: input.notificationsEnabled,
    next_check_at: nextCheckAt,
    updated_by: userUuid,
    updated_at: new Date(),
  }).onConflictDoUpdate({
    target: GpuHealthMonitorSettings.setting_id,
    set: {
      enabled: input.enabled,
      check_interval_minutes: input.checkIntervalMinutes,
      retention_days: input.retentionDays,
      notifications_enabled: input.notificationsEnabled,
      next_check_at: nextCheckAt,
      updated_by: userUuid,
      updated_at: new Date(),
    },
  }).returning();
  return settings!;
};

export const addGpuHealthRecipient = async (email: string, userUuid: string) => {
  const normalized = email.trim().toLowerCase();
  const [recipient] = await db.insert(GpuHealthRecipients)
    .values({ email: normalized, created_by: userUuid })
    .onConflictDoNothing({ target: GpuHealthRecipients.email })
    .returning();
  if (recipient) return recipient;
  const [existing] = await db.select().from(GpuHealthRecipients)
    .where(eq(GpuHealthRecipients.email, normalized)).limit(1);
  return existing!;
};

export const removeGpuHealthRecipient = async (recipientUuid: string) => {
  const [removed] = await db.delete(GpuHealthRecipients)
    .where(eq(GpuHealthRecipients.recipient_uuid, recipientUuid)).returning();
  return removed ?? null;
};

const checkContext = (current: "healthy" | "unhealthy", previous?: string) => {
  if (!previous) return current === "healthy" ? "initial_healthy" : "incident_detected";
  if (current === "healthy" && previous === "unhealthy") return "recovered";
  if (current === "unhealthy" && previous === "healthy") return "incident_detected";
  return current === "healthy" ? "routine_healthy" : "still_unhealthy";
};

const contextLabel: Record<string, string> = {
  initial_healthy: "Initial health check passed",
  routine_healthy: "GPU service is healthy",
  recovered: "GPU service recovered",
  incident_detected: "GPU service incident detected",
  still_unhealthy: "GPU service remains unavailable",
};

const maskedEmail = (email: string) => {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
};

const readableCheckTime = (date: Date) => {
  const configuredTimezone = process.env.GPU_HEALTH_TIMEZONE?.trim()
    || process.env.DAILY_USER_REPORT_TIMEZONE?.trim()
    || "Asia/Kolkata";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: configuredTimezone,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).format(date).replace(/\b(am|pm)\b/g, (period) => period.toUpperCase());
  } catch {
    return date.toISOString();
  }
};

const notifyRecipients = async (log: typeof GpuHealthCheckLogs.$inferSelect) => {
  const recipients = await db.select().from(GpuHealthRecipients);
  if (!recipients.length) {
    console.info("[gpu-health-email] Delivery skipped: no recipients configured", {
      checkUuid: log.check_uuid,
      healthStatus: log.status,
    });
    return { status: "no_recipients", count: 0, error: null };
  }
  const title = contextLabel[log.context] || "GPU health update";
  const message = [
    `Status: ${log.status.toUpperCase()}.`,
    `Checked at: ${readableCheckTime(log.checked_at)}.`,
    `Endpoint: ${log.endpoint}.`,
    `Response time: ${log.duration_ms} ms.`,
    `HTTP status: ${log.http_status ?? "not received"}.`,
    log.error_message ? `Details: ${log.error_message}` : "The GPU health endpoint responded successfully.",
  ].join(" ");
  const email = renderEbmaNoticeEmail({
    name: "Operations team",
    title,
    message,
    actionLabel: "Open GPU health monitor",
    actionUrl: `${(process.env.PORTAL_URL || "https://admin.ebma.ai").replace(/\/$/, "")}/platform/admin/gpu-health`,
  });
  console.info("[gpu-health-email] Starting delivery", {
    checkUuid: log.check_uuid,
    healthStatus: log.status,
    context: log.context,
    recipientCount: recipients.length,
    recipients: recipients.map((recipient) => maskedEmail(recipient.email)),
  });
  const deliveries = await Promise.allSettled(recipients.map((recipient) => sendEmail({
    to: recipient.email,
    subject: `[ebma AI] ${title}`,
    html: email,
    text: `${title}\n\n${message}`,
    idempotencyKey: `gpu-health-${log.check_uuid}-${recipient.recipient_uuid}`,
  })));
  deliveries.forEach((delivery, index) => {
    const recipient = recipients[index];
    const emailAddress = recipient ? maskedEmail(recipient.email) : "unknown";
    if (delivery.status === "fulfilled") {
      console.info("[gpu-health-email] Delivery succeeded", {
        checkUuid: log.check_uuid,
        recipient: emailAddress,
        provider: delivery.value.provider,
        messageId: delivery.value.messageId,
      });
      return;
    }
    console.error("[gpu-health-email] Delivery failed", {
      checkUuid: log.check_uuid,
      recipient: emailAddress,
      error: delivery.reason instanceof Error ? delivery.reason.message : String(delivery.reason),
    });
  });
  const failures = deliveries.filter((item): item is PromiseRejectedResult => item.status === "rejected");
  const result = {
    status: failures.length ? (failures.length === deliveries.length ? "failed" : "partially_sent") : "sent",
    count: deliveries.length - failures.length,
    error: failures.length ? failures.map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason)).join("; ").slice(0, 2000) : null,
  };
  console.info("[gpu-health-email] Delivery completed", {
    checkUuid: log.check_uuid,
    status: result.status,
    deliveredCount: result.count,
    failedCount: failures.length,
  });
  return result;
};

export const runGpuHealthCheck = async (trigger: "scheduled" | "manual") => {
  const settings = await ensureSettings();
  const [previous] = await db.select({ status: GpuHealthCheckLogs.status })
    .from(GpuHealthCheckLogs).orderBy(desc(GpuHealthCheckLogs.checked_at)).limit(1);
  const started = Date.now();
  let endpoint = "Not configured";
  let method = "GET";
  let status: "healthy" | "unhealthy" = "unhealthy";
  let httpStatus: number | null = null;
  let body: string | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  try {
    const probe = configuredProbe();
    endpoint = safeEndpoint(probe.endpoint);
    method = probe.method;
    const response = await fetch(probe.endpoint, {
      method: probe.method,
      headers: modelHeaders(),
      signal: AbortSignal.timeout(healthTimeoutMs()),
    });
    httpStatus = response.status;
    body = await responseText(response);
    const fallbackReachable = probe.method === "OPTIONS" && response.status < 500 && ![401, 403, 404].includes(response.status);
    if (!response.ok && !fallbackReachable) {
      errorCode = "unhealthy_response";
      errorMessage = `GPU health endpoint returned HTTP ${response.status}`;
    } else {
      status = "healthy";
    }
  } catch (error) {
    errorCode = (error as { code?: string })?.code || ((error as Error)?.name === "TimeoutError" ? "health_check_timeout" : "health_check_failed");
    errorMessage = error instanceof Error ? error.message : "GPU health check failed";
  }

  const [inserted] = await db.insert(GpuHealthCheckLogs).values({
    trigger,
    status,
    context: checkContext(status, previous?.status),
    endpoint,
    method,
    http_status: httpStatus,
    duration_ms: Math.max(0, Date.now() - started),
    response_body: body,
    error_code: errorCode,
    error_message: errorMessage,
    checked_at: new Date(),
  }).returning();
  let result = inserted!;

  if (settings.notifications_enabled) {
    const delivery = await notifyRecipients(result);
    const [updated] = await db.update(GpuHealthCheckLogs).set({
      notification_status: delivery.status,
      notification_recipient_count: delivery.count,
      notification_error: delivery.error,
    }).where(eq(GpuHealthCheckLogs.check_uuid, result.check_uuid)).returning();
    if (updated) result = updated;
  }
  await db.update(GpuHealthMonitorSettings).set({ last_check_at: result.checked_at })
    .where(eq(GpuHealthMonitorSettings.setting_id, SINGLETON_ID));
  return result;
};

export const claimAndRunScheduledGpuHealthCheck = async () => {
  await ensureSettings();
  const [claimed] = await db.update(GpuHealthMonitorSettings).set({
    next_check_at: sql`now() + (${GpuHealthMonitorSettings.check_interval_minutes} * interval '1 minute')`,
  }).where(and(
    eq(GpuHealthMonitorSettings.setting_id, SINGLETON_ID),
    eq(GpuHealthMonitorSettings.enabled, true),
    sql`${GpuHealthMonitorSettings.next_check_at} <= now()`,
  )).returning();
  return claimed ? runGpuHealthCheck("scheduled") : null;
};

export const listGpuHealthChecks = async (query: Record<string, unknown>) => {
  const page = clampInteger(query.page, 1, 1, 1_000_000);
  const pageSize = clampInteger(query.pageSize, 25, 1, 100);
  const status = query.status === "healthy" || query.status === "unhealthy" ? query.status : undefined;
  const search = typeof query.search === "string" ? query.search.trim().slice(0, 200) : "";
  const filters = and(
    status ? eq(GpuHealthCheckLogs.status, status) : undefined,
    search ? or(
      ilike(GpuHealthCheckLogs.endpoint, `%${search}%`),
      ilike(GpuHealthCheckLogs.error_message, `%${search}%`),
      ilike(GpuHealthCheckLogs.response_body, `%${search}%`),
    ) : undefined,
  );
  const [count] = await db.select({ value: sql<number>`count(*)::int` }).from(GpuHealthCheckLogs).where(filters);
  const items = await db.select().from(GpuHealthCheckLogs).where(filters)
    .orderBy(desc(GpuHealthCheckLogs.checked_at)).limit(pageSize).offset((page - 1) * pageSize);
  const total = Number(count?.value ?? 0);
  return { items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize), hasNextPage: page * pageSize < total } };
};

export const cleanupGpuHealthChecks = async () => {
  const settings = await ensureSettings();
  const cutoff = new Date(Date.now() - settings.retention_days * 86_400_000);
  const removed = await db.delete(GpuHealthCheckLogs).where(lt(GpuHealthCheckLogs.checked_at, cutoff)).returning({ id: GpuHealthCheckLogs.check_uuid });
  return { retentionDays: settings.retention_days, cutoff, deleted: removed.length };
};
