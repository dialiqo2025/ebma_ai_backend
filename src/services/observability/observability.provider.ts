import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, ilike, isNotNull, lte, lt, or, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import {
  ApiTransactionLogs,
  GpuServiceLogs,
  ObservabilitySettings,
  SttTranscriptions,
  Users,
} from "../../schema";
import { currentRequestContext } from "./observability.context";

const MAX_TEXT = 2_000;
const MAX_SERIALIZED = 16_000;
const SENSITIVE_KEY = /authorization|cookie|password|token|secret|api[_-]?key|audio_base64|file|buffer/i;
const artifactDirectory = path.resolve(process.cwd(), "storage", "monitoring", "stt");

const truncate = (value: string, max = MAX_TEXT) =>
  value.length > max ? `${value.slice(0, max)}…[truncated]` : value;

export const sanitizeLogValue = (value: unknown, depth = 0): unknown => {
  if (value === null || value === undefined) return value;
  if (depth > 5) return "[maximum depth reached]";
  if (Buffer.isBuffer(value)) return `[binary data: ${value.length} bytes]`;
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeLogValue(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeLogValue(item, depth + 1);
    }
    try {
      const encoded = JSON.stringify(result);
      return encoded.length > MAX_SERIALIZED
        ? { summary: truncate(encoded, MAX_SERIALIZED), truncated: true }
        : result;
    } catch {
      return "[unserializable value]";
    }
  }
  return truncate(String(value));
};

export const recordApiTransaction = async (input: {
  requestId: string;
  userUuid?: string;
  apiKeyUuid?: string;
  method: string;
  path: string;
  module: string;
  functionality: string;
  status: "success" | "failed";
  httpStatus: number;
  description: string;
  errorCode?: string;
  errorMessage?: string;
  requestMetadata?: unknown;
  responseMetadata?: unknown;
  ipAddress?: string;
  userAgent?: string;
  durationMs: number;
}) => {
  await db.insert(ApiTransactionLogs).values({
    request_id: input.requestId,
    user_uuid: input.userUuid ?? null,
    api_key_uuid: input.apiKeyUuid ?? null,
    method: input.method,
    path: truncate(input.path, 1000),
    module: truncate(input.module, 100),
    functionality: truncate(input.functionality, 255),
    status: input.status,
    http_status: input.httpStatus,
    description: truncate(input.description),
    error_code: input.errorCode ? truncate(input.errorCode, 150) : null,
    error_message: input.errorMessage ? truncate(input.errorMessage) : null,
    request_metadata: sanitizeLogValue(input.requestMetadata),
    response_metadata: sanitizeLogValue(input.responseMetadata),
    ip_address: input.ipAddress ? truncate(input.ipAddress, 128) : null,
    user_agent: input.userAgent ? truncate(input.userAgent, 1000) : null,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
  });
};

type GpuObservationOptions<T> = {
  service: "stt" | "tts";
  operation: string;
  endpoint: string;
  requestMetadata?: unknown;
  responseMetadata?: (result: T) => unknown;
  providerReference?: (result: T) => string | undefined;
  isSuccess?: (result: T) => boolean;
  upstreamStatus?: (result: T) => number | undefined;
  artifact?: { data: Buffer; originalName: string; contentType?: string };
};

const safeArtifactExtension = (name: string) => {
  const extension = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".bin";
};

const persistGpuObservation = async <T>(
  options: GpuObservationOptions<T>,
  startedAt: number,
  result: T | undefined,
  error: unknown,
) => {
  const context = currentRequestContext();
  const request = context?.request;
  let artifactFileName: string | null = null;

  try {
    if (options.artifact?.data.length) {
      artifactFileName = `${randomUUID()}${safeArtifactExtension(options.artifact.originalName)}`;
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(path.join(artifactDirectory, artifactFileName), options.artifact.data, { flag: "wx" });
    }

    const modelError = error as { code?: string; message?: string; httpStatus?: number } | undefined;
    const succeeded = !error && (result === undefined || !options.isSuccess || options.isSuccess(result));
    const upstreamStatus = result !== undefined && options.upstreamStatus
      ? options.upstreamStatus(result)
      : modelError?.httpStatus;
    await db.insert(GpuServiceLogs).values({
      request_id: context?.requestId ?? null,
      user_uuid: request?.user?.userId ?? null,
      api_key_uuid: request?.user?.apiKeyId ?? null,
      service: options.service,
      operation: options.operation,
      endpoint: truncate(options.endpoint.replace(/[?#].*$/, ""), 1000),
      status: succeeded ? "success" : "failed",
      upstream_status: upstreamStatus ?? null,
      description: !succeeded
        ? `${options.service.toUpperCase()} ${options.operation.replaceAll("_", " ")} failed${modelError?.message ? `: ${modelError.message}` : upstreamStatus ? ` with HTTP ${upstreamStatus}` : ""}`
        : `${options.service.toUpperCase()} ${options.operation.replaceAll("_", " ")} completed successfully`,
      error_code: modelError?.code ? truncate(modelError.code, 150) : (!succeeded && upstreamStatus ? `upstream_http_${upstreamStatus}` : null),
      error_message: modelError?.message ? truncate(modelError.message) : (!succeeded && upstreamStatus ? `GPU endpoint returned HTTP ${upstreamStatus}` : null),
      provider_reference: result && options.providerReference
        ? truncate(options.providerReference(result) || "", 255) || null
        : null,
      request_metadata: sanitizeLogValue(options.requestMetadata),
      response_metadata: result && options.responseMetadata
        ? sanitizeLogValue(options.responseMetadata(result))
        : null,
      artifact_file_name: artifactFileName,
      artifact_original_name: options.artifact?.originalName
        ? truncate(options.artifact.originalName, 512)
        : null,
      artifact_content_type: options.artifact?.contentType
        ? truncate(options.artifact.contentType, 255)
        : null,
      duration_ms: Math.max(0, Date.now() - startedAt),
    });
  } catch (loggingError) {
    if (artifactFileName) await unlink(path.join(artifactDirectory, artifactFileName)).catch(() => undefined);
    console.error("GPU monitoring persistence failed:", loggingError);
  }
};

/** Observe a GPU call without changing its return value, error, or response latency. */
export const observeGpuCall = async <T>(options: GpuObservationOptions<T>, call: () => Promise<T>) => {
  const startedAt = Date.now();
  try {
    const result = await call();
    void persistGpuObservation(options, startedAt, result, undefined);
    return result;
  } catch (error) {
    void persistGpuObservation(options, startedAt, undefined, error);
    throw error;
  }
};

/** Add the terminal STT result to monitoring after the provider job snapshot is persisted. */
export const recordSttResultObservation = async (input: {
  transcriptionUuid: string;
  providerReference: string;
  status: "completed" | "failed" | "cancelled";
  transcript: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  result?: unknown;
}) => {
  const context = currentRequestContext();
  const request = context?.request;
  await db.insert(GpuServiceLogs).values({
    request_id: context?.requestId ?? null,
    user_uuid: request?.user?.userId ?? null,
    api_key_uuid: request?.user?.apiKeyId ?? null,
    service: "stt",
    operation: "transcription_result",
    endpoint: "stored://stt/transcription-result",
    status: input.status === "completed" ? "success" : "failed",
    description: input.status === "completed"
      ? "STT transcription completed successfully; the transcript is available for review and download"
      : `STT transcription ${input.status}: ${input.errorMessage || "The GPU service did not produce a completed transcript"}`,
    error_code: input.errorCode ?? null,
    error_message: input.errorMessage ?? null,
    provider_reference: truncate(input.providerReference, 255),
    request_metadata: { transcriptionUuid: input.transcriptionUuid },
    response_metadata: sanitizeLogValue({
      transcriptionUuid: input.transcriptionUuid,
      transcriptAvailable: Boolean(input.transcript),
      transcript: input.transcript,
      result: input.result,
    }),
    duration_ms: 0,
  });
};

/** Attach the provider job id after the upload response body has been parsed. */
export const linkCurrentSttUpload = (providerReference: string) => {
  const context = currentRequestContext();
  const requestId = context?.requestId;
  if (!requestId || !providerReference) return;

  const link = async (attempt: number): Promise<void> => {
    try {
      const updated = await db.update(GpuServiceLogs)
        .set({ provider_reference: truncate(providerReference, 255) })
        .where(and(
          eq(GpuServiceLogs.request_id, requestId),
          eq(GpuServiceLogs.service, "stt"),
          eq(GpuServiceLogs.operation, "create_transcription"),
        ))
        .returning({ logUuid: GpuServiceLogs.log_uuid });
      if (updated.length || attempt >= 6) return;
      setTimeout(() => void link(attempt + 1), attempt * 400).unref();
    } catch (error) {
      if (attempt >= 6) console.error("STT upload monitoring link failed:", error);
      else setTimeout(() => void link(attempt + 1), attempt * 400).unref();
    }
  };

  void link(1);
};

const pageInput = (value: unknown, fallback: number, max: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

const dateInput = (value: unknown) => {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
};

const userUuidInput = (value: unknown) =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;

export const listApiTransactions = async (query: Record<string, unknown>) => {
  const page = pageInput(query.page, 1, 1_000_000);
  const pageSize = pageInput(query.pageSize, 25, 100);
  const search = typeof query.search === "string" ? query.search.trim() : "";
  const filters = and(
    query.status === "success" || query.status === "failed"
      ? eq(ApiTransactionLogs.status, query.status)
      : undefined,
    typeof query.module === "string" && query.module ? eq(ApiTransactionLogs.module, query.module) : undefined,
    userUuidInput(query.userUuid) ? eq(ApiTransactionLogs.user_uuid, userUuidInput(query.userUuid)!) : undefined,
    dateInput(query.from) ? gte(ApiTransactionLogs.created_at, dateInput(query.from)!) : undefined,
    dateInput(query.to) ? lte(ApiTransactionLogs.created_at, dateInput(query.to)!) : undefined,
    search
      ? or(
          ilike(ApiTransactionLogs.path, `%${search}%`),
          ilike(ApiTransactionLogs.description, `%${search}%`),
          ilike(Users.email, `%${search}%`),
        )
      : undefined,
  );
  const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(ApiTransactionLogs)
    .leftJoin(Users, eq(ApiTransactionLogs.user_uuid, Users.user_uuid)).where(filters);
  const items = await db.select({ log: ApiTransactionLogs, userEmail: Users.email, userName: Users.fullName })
    .from(ApiTransactionLogs).leftJoin(Users, eq(ApiTransactionLogs.user_uuid, Users.user_uuid))
    .where(filters).orderBy(desc(ApiTransactionLogs.created_at)).limit(pageSize).offset((page - 1) * pageSize);
  const total = Number(countRow?.count ?? 0);
  return { items: items.map(({ log, ...user }) => ({ ...log, ...user })), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize), hasNextPage: page * pageSize < total } };
};

export const listGpuTransactions = async (query: Record<string, unknown>) => {
  const page = pageInput(query.page, 1, 1_000_000);
  const pageSize = pageInput(query.pageSize, 25, 100);
  const search = typeof query.search === "string" ? query.search.trim() : "";
  const filters = and(
    query.status === "success" || query.status === "failed" ? eq(GpuServiceLogs.status, query.status) : undefined,
    query.service === "stt" || query.service === "tts" ? eq(GpuServiceLogs.service, query.service) : undefined,
    userUuidInput(query.userUuid) ? eq(GpuServiceLogs.user_uuid, userUuidInput(query.userUuid)!) : undefined,
    dateInput(query.from) ? gte(GpuServiceLogs.created_at, dateInput(query.from)!) : undefined,
    dateInput(query.to) ? lte(GpuServiceLogs.created_at, dateInput(query.to)!) : undefined,
    search ? or(ilike(GpuServiceLogs.operation, `%${search}%`), ilike(GpuServiceLogs.description, `%${search}%`), ilike(Users.email, `%${search}%`)) : undefined,
  );
  const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(GpuServiceLogs)
    .leftJoin(Users, eq(GpuServiceLogs.user_uuid, Users.user_uuid)).where(filters);
  const items = await db.select({ log: GpuServiceLogs, userEmail: Users.email, userName: Users.fullName })
    .from(GpuServiceLogs).leftJoin(Users, eq(GpuServiceLogs.user_uuid, Users.user_uuid))
    .where(filters).orderBy(desc(GpuServiceLogs.created_at)).limit(pageSize).offset((page - 1) * pageSize);
  const total = Number(countRow?.count ?? 0);
  return { items: items.map(({ log, ...user }) => ({ ...log, ...user })), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize), hasNextPage: page * pageSize < total } };
};

export const listObservedUsers = async (query: Record<string, unknown>) => {
  const page = pageInput(query.page, 1, 1_000_000);
  const pageSize = pageInput(query.pageSize, 25, 100);
  const search = typeof query.search === "string" ? query.search.trim() : "";
  const filters = search
    ? or(ilike(Users.fullName, `%${search}%`), ilike(Users.email, `%${search}%`))
    : undefined;
  const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(Users).where(filters);
  const items = await db.select({ user_uuid: Users.user_uuid, fullName: Users.fullName, email: Users.email })
    .from(Users)
    .where(filters)
    .orderBy(Users.fullName, Users.email)
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const total = Number(countRow?.count ?? 0);
  return {
    items,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      hasNextPage: page * pageSize < total,
    },
  };
};

export const getObservabilitySettings = async () => {
  const [existing] = await db.select().from(ObservabilitySettings).where(eq(ObservabilitySettings.setting_id, 1)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(ObservabilitySettings).values({ setting_id: 1, retention_days: 7 }).onConflictDoNothing().returning();
  if (created) return created;
  const [current] = await db.select().from(ObservabilitySettings).where(eq(ObservabilitySettings.setting_id, 1)).limit(1);
  return current!;
};

export const updateObservabilitySettings = async (retentionDays: number, userUuid: string) => {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error("Retention days must be a whole number between 1 and 365");
  }
  const [updated] = await db.insert(ObservabilitySettings)
    .values({ setting_id: 1, retention_days: retentionDays, updated_by: userUuid, updated_at: new Date() })
    .onConflictDoUpdate({ target: ObservabilitySettings.setting_id, set: { retention_days: retentionDays, updated_by: userUuid, updated_at: new Date() } })
    .returning();
  return updated;
};

export const monitoredArtifact = async (logUuid: string) => {
  const [row] = await db.select().from(GpuServiceLogs).where(eq(GpuServiceLogs.log_uuid, logUuid)).limit(1);
  if (!row) return null;
  let source = row.artifact_file_name ? row : undefined;

  // Result rows are separate from upload-call rows. Prefer an exact provider
  // reference, then use transcription metadata for records created before the
  // correlation link was introduced.
  if (!source && row.service === "stt" && row.operation === "transcription_result") {
    if (row.provider_reference) {
      [source] = await db.select().from(GpuServiceLogs).where(and(
        eq(GpuServiceLogs.service, "stt"),
        eq(GpuServiceLogs.operation, "create_transcription"),
        eq(GpuServiceLogs.provider_reference, row.provider_reference),
        isNotNull(GpuServiceLogs.artifact_file_name),
      )).orderBy(desc(GpuServiceLogs.created_at)).limit(1);
    }

    if (!source) {
      const transcriptionUuid = (row.request_metadata as { transcriptionUuid?: unknown } | null)?.transcriptionUuid;
      if (typeof transcriptionUuid === "string") {
        const [transcription] = await db.select().from(SttTranscriptions)
          .where(eq(SttTranscriptions.transcription_uuid, transcriptionUuid)).limit(1);
        if (transcription) {
          [source] = await db.select().from(GpuServiceLogs).where(and(
            eq(GpuServiceLogs.service, "stt"),
            eq(GpuServiceLogs.operation, "create_transcription"),
            eq(GpuServiceLogs.user_uuid, transcription.user_uuid),
            eq(GpuServiceLogs.artifact_original_name, transcription.original_filename),
            isNotNull(GpuServiceLogs.artifact_file_name),
            gte(GpuServiceLogs.created_at, new Date(transcription.created_at.getTime() - 5 * 60_000)),
            lte(GpuServiceLogs.created_at, new Date(transcription.created_at.getTime() + 5 * 60_000)),
          )).orderBy(desc(GpuServiceLogs.created_at)).limit(1);
        }
      }
    }
  }

  if (!source?.artifact_file_name) return null;
  return { path: path.join(artifactDirectory, path.basename(source.artifact_file_name)), name: source.artifact_original_name || "transcription-audio", contentType: source.artifact_content_type || "application/octet-stream" };
};

export const monitoredTranscript = async (logUuid: string) => {
  const [log] = await db.select().from(GpuServiceLogs).where(eq(GpuServiceLogs.log_uuid, logUuid)).limit(1);
  const transcriptionUuid = (log?.request_metadata as { transcriptionUuid?: unknown } | null)?.transcriptionUuid;
  if (log?.service !== "stt" || log.operation !== "transcription_result" || typeof transcriptionUuid !== "string") return null;
  const [row] = await db.select({ transcript: SttTranscriptions.transcript, originalName: SttTranscriptions.original_filename })
    .from(SttTranscriptions).where(eq(SttTranscriptions.transcription_uuid, transcriptionUuid)).limit(1);
  if (!row?.transcript) return null;
  const baseName = path.basename(row.originalName, path.extname(row.originalName)).replace(/[^a-zA-Z0-9._-]/g, "_") || "transcription";
  return { content: row.transcript, fileName: `${baseName}.txt` };
};

export const cleanupExpiredObservabilityLogs = async () => {
  const settings = await getObservabilitySettings();
  const cutoff = new Date(Date.now() - settings.retention_days * 86_400_000);
  const expiredGpu = await db.select({ fileName: GpuServiceLogs.artifact_file_name }).from(GpuServiceLogs).where(lt(GpuServiceLogs.created_at, cutoff));
  await db.delete(ApiTransactionLogs).where(lt(ApiTransactionLogs.created_at, cutoff));
  await db.delete(GpuServiceLogs).where(lt(GpuServiceLogs.created_at, cutoff));
  await Promise.all(expiredGpu.filter((item) => item.fileName).map((item) => unlink(path.join(artifactDirectory, path.basename(item.fileName!))).catch(() => undefined)));
  // Remove orphaned monitoring files left by an interrupted write/insert.
  await mkdir(artifactDirectory, { recursive: true });
  const referenced = new Set((await db.select({ fileName: GpuServiceLogs.artifact_file_name }).from(GpuServiceLogs)).map((item) => item.fileName).filter(Boolean));
  for (const file of await readdir(artifactDirectory)) if (!referenced.has(file)) await unlink(path.join(artifactDirectory, file)).catch(() => undefined);
  return { retentionDays: settings.retention_days, cutoff, apiDeleted: undefined, gpuDeleted: expiredGpu.length };
};
