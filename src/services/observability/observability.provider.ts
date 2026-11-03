import { access, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, ilike, inArray, isNotNull, lte, lt, or, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import {
  ApiTransactionLogs,
  GpuServiceLogs,
  ObservabilitySettings,
  SttTranscriptions,
  SttSessions,
  TtsGenerations,
  BillingUsageLedger,
  Users,
} from "../../schema";
import { currentRequestContext } from "./observability.context";
import { audioMimeTypeByFormat, getTtsAudioPath } from "../tts/tts.helper";

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
    .where(filters)
    .orderBy(desc(ApiTransactionLogs.created_at), desc(ApiTransactionLogs.log_uuid))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
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
    .where(filters)
    .orderBy(desc(GpuServiceLogs.created_at), desc(GpuServiceLogs.log_uuid))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const total = Number(countRow?.count ?? 0);
  return { items: items.map(({ log, ...user }) => ({ ...log, ...user })), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize), hasNextPage: page * pageSize < total } };
};

const operationStatus = (status: string) =>
  status === "completed" ? "success" : ["failed", "cancelled"].includes(status) ? "failed" : "processing";

/** One row per user-visible STT transcription or TTS generation. */
export const listGpuOperations = async (query: Record<string, unknown>) => {
  const page = pageInput(query.page, 1, 1_000_000);
  const pageSize = pageInput(query.pageSize, 25, 100);
  const offset = (page - 1) * pageSize;
  const take = offset + pageSize;
  const search = typeof query.search === "string" ? query.search.trim() : "";
  const requestedFrom = dateInput(query.from);
  const retention = requestedFrom ? null : await getObservabilitySettings();
  const from = requestedFrom ?? new Date(Date.now() - (retention?.retention_days ?? 7) * 86_400_000);
  const to = dateInput(query.to);
  const userUuid = userUuidInput(query.userUuid);
  const requestedStatus = ["success", "failed", "processing"].includes(String(query.status)) ? String(query.status) : undefined;
  const includeStt = query.service !== "tts";
  const includeTts = query.service !== "stt";
  const sttStatus = requestedStatus === "success"
    ? eq(SttTranscriptions.status, "completed")
    : requestedStatus === "failed"
      ? sql`${SttTranscriptions.status} in ('failed', 'cancelled')`
      : requestedStatus === "processing"
        ? sql`${SttTranscriptions.status} not in ('completed', 'failed', 'cancelled')`
        : undefined;
  const ttsStatus = requestedStatus === "success"
    ? eq(TtsGenerations.status, "completed")
    : requestedStatus === "failed"
      ? eq(TtsGenerations.status, "failed")
      : requestedStatus === "processing"
        ? sql`${TtsGenerations.status} not in ('completed', 'failed')`
        : undefined;
  const sttFilters = and(
    sttStatus,
    userUuid ? eq(SttTranscriptions.user_uuid, userUuid) : undefined,
    from ? gte(SttTranscriptions.created_at, from) : undefined,
    to ? lte(SttTranscriptions.created_at, to) : undefined,
    search ? or(ilike(SttTranscriptions.original_filename, `%${search}%`), ilike(Users.email, `%${search}%`), ilike(Users.fullName, `%${search}%`)) : undefined,
  );
  const sessionStatus = requestedStatus === "success"
    ? eq(SttSessions.status, "completed")
    : requestedStatus === "failed"
      ? eq(SttSessions.status, "failed")
      : requestedStatus === "processing"
        ? sql`${SttSessions.status} not in ('completed', 'failed')`
        : undefined;
  const sessionFilters = and(
    sessionStatus,
    userUuid ? eq(SttSessions.user_uuid, userUuid) : undefined,
    from ? gte(SttSessions.created_at, from) : undefined,
    to ? lte(SttSessions.created_at, to) : undefined,
    search ? or(ilike(SttSessions.transcript, `%${search}%`), ilike(Users.email, `%${search}%`), ilike(Users.fullName, `%${search}%`)) : undefined,
  );
  const ttsFilters = and(
    ttsStatus,
    userUuid ? eq(TtsGenerations.user_uuid, userUuid) : undefined,
    from ? gte(TtsGenerations.created_at, from) : undefined,
    to ? lte(TtsGenerations.created_at, to) : undefined,
    search ? or(ilike(TtsGenerations.input_text, `%${search}%`), ilike(Users.email, `%${search}%`), ilike(Users.fullName, `%${search}%`)) : undefined,
  );

  const [sttRows, sessionRows, ttsRows, sttCount, sessionCount, ttsCount] = await Promise.all([
    includeStt
      ? db.select({ operation: SttTranscriptions, userEmail: Users.email, userName: Users.fullName }).from(SttTranscriptions)
          .leftJoin(Users, eq(SttTranscriptions.user_uuid, Users.user_uuid)).where(sttFilters)
          .orderBy(desc(SttTranscriptions.created_at)).limit(take)
      : Promise.resolve([]),
    includeStt
      ? db.select({ operation: SttSessions, userEmail: Users.email, userName: Users.fullName }).from(SttSessions)
          .leftJoin(Users, eq(SttSessions.user_uuid, Users.user_uuid)).where(sessionFilters)
          .orderBy(desc(SttSessions.created_at)).limit(take)
      : Promise.resolve([]),
    includeTts
      ? db.select({ operation: TtsGenerations, userEmail: Users.email, userName: Users.fullName }).from(TtsGenerations)
          .leftJoin(Users, eq(TtsGenerations.user_uuid, Users.user_uuid)).where(ttsFilters)
          .orderBy(desc(TtsGenerations.created_at)).limit(take)
      : Promise.resolve([]),
    includeStt ? db.select({ count: sql<number>`count(*)::int` }).from(SttTranscriptions).leftJoin(Users, eq(SttTranscriptions.user_uuid, Users.user_uuid)).where(sttFilters) : Promise.resolve([{ count: 0 }]),
    includeStt ? db.select({ count: sql<number>`count(*)::int` }).from(SttSessions).leftJoin(Users, eq(SttSessions.user_uuid, Users.user_uuid)).where(sessionFilters) : Promise.resolve([{ count: 0 }]),
    includeTts ? db.select({ count: sql<number>`count(*)::int` }).from(TtsGenerations).leftJoin(Users, eq(TtsGenerations.user_uuid, Users.user_uuid)).where(ttsFilters) : Promise.resolve([{ count: 0 }]),
  ]);

  const operations = [
    ...sttRows.map(({ operation, ...user }) => ({
      operationUuid: operation.transcription_uuid,
      service: "stt" as const,
      operationType: "transcription",
      status: operationStatus(operation.status),
      rawStatus: operation.status,
      title: operation.original_filename,
      userUuid: operation.user_uuid,
      ...user,
      requestId: operation.request_id,
      providerReference: operation.provider_job_id,
      fileSizeBytes: operation.file_size_bytes,
      inputUnits: operation.file_size_bytes,
      outputUnits: operation.transcript.length,
      audioSeconds: operation.audio_seconds,
      errorCode: operation.error_code,
      errorMessage: operation.error_message,
      createdAt: operation.created_at,
      startedAt: operation.created_at,
      completedAt: operation.completed_at,
    })),
    ...sessionRows.map(({ operation, ...user }) => ({
      operationUuid: operation.session_uuid,
      service: "stt" as const,
      operationType: "live session",
      status: operationStatus(operation.status),
      rawStatus: operation.status,
      title: `Live ${operation.language.toUpperCase()} · ${operation.output_mode}`,
      userUuid: operation.user_uuid,
      ...user,
      requestId: operation.request_id,
      providerReference: null,
      fileSizeBytes: null,
      inputUnits: operation.phrase_count,
      outputUnits: operation.transcript.length,
      audioSeconds: operation.audio_duration_seconds,
      errorCode: operation.error_code,
      errorMessage: operation.error_message,
      createdAt: operation.created_at,
      startedAt: operation.started_at ?? operation.created_at,
      completedAt: operation.completed_at,
    })),
    ...ttsRows.map(({ operation, ...user }) => ({
      operationUuid: operation.generation_uuid,
      service: "tts" as const,
      operationType: "generation",
      status: operationStatus(operation.status),
      rawStatus: operation.status,
      title: truncate(operation.input_text, 120),
      userUuid: operation.user_uuid,
      ...user,
      requestId: operation.request_id,
      providerReference: operation.provider_request_id,
      fileSizeBytes: operation.audio_size_bytes,
      inputUnits: operation.input_text.length,
      outputUnits: operation.audio_size_bytes,
      audioSeconds: null,
      errorCode: operation.error_code,
      errorMessage: operation.error_message,
      createdAt: operation.created_at,
      startedAt: operation.started_at ?? operation.created_at,
      completedAt: operation.completed_at,
    })),
  ].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()).slice(offset, offset + pageSize);

  const sttIds = operations.filter((item) => item.operationType === "transcription").map((item) => item.operationUuid);
  const sessionIds = operations.filter((item) => item.operationType === "live session").map((item) => item.operationUuid);
  const ttsIds = operations.filter((item) => item.service === "tts").map((item) => item.operationUuid);
  const usageRows = sttIds.length || sessionIds.length || ttsIds.length
    ? await db.select().from(BillingUsageLedger).where(or(
        sttIds.length ? inArray(sql<string>`${BillingUsageLedger.metadata}->>'transcriptionUuid'`, sttIds) : undefined,
        sessionIds.length ? inArray(sql<string>`${BillingUsageLedger.metadata}->>'sessionUuid'`, sessionIds) : undefined,
        ttsIds.length ? inArray(sql<string>`${BillingUsageLedger.metadata}->>'generationUuid'`, ttsIds) : undefined,
      ))
    : [];
  const total = Number(sttCount[0]?.count ?? 0) + Number(sessionCount[0]?.count ?? 0) + Number(ttsCount[0]?.count ?? 0);
  return {
    items: operations.map((operation) => {
      const usage = usageRows.filter((row) => {
        const metadata = row.metadata as { transcriptionUuid?: unknown; sessionUuid?: unknown; generationUuid?: unknown } | null;
        return metadata?.transcriptionUuid === operation.operationUuid || metadata?.sessionUuid === operation.operationUuid || metadata?.generationUuid === operation.operationUuid;
      });
      return { ...operation, chargedCredits: usage.reduce((sum, row) => sum + Number(row.charged_credits), 0), usageEvents: usage.length };
    }),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize), hasNextPage: offset + operations.length < total },
  };
};

export const getGpuOperationStatistics = async (query: Record<string, unknown>) => {
  const requestedFrom = dateInput(query.from);
  const retention = requestedFrom ? null : await getObservabilitySettings();
  const from = requestedFrom ?? new Date(Date.now() - (retention?.retention_days ?? 7) * 86_400_000);
  const to = dateInput(query.to);
  const userUuid = userUuidInput(query.userUuid);
  const sttFilter = and(
    userUuid ? eq(SttTranscriptions.user_uuid, userUuid) : undefined,
    gte(SttTranscriptions.created_at, from),
    to ? lte(SttTranscriptions.created_at, to) : undefined,
  );
  const sessionFilter = and(
    userUuid ? eq(SttSessions.user_uuid, userUuid) : undefined,
    gte(SttSessions.created_at, from),
    to ? lte(SttSessions.created_at, to) : undefined,
  );
  const ttsFilter = and(
    userUuid ? eq(TtsGenerations.user_uuid, userUuid) : undefined,
    gte(TtsGenerations.created_at, from),
    to ? lte(TtsGenerations.created_at, to) : undefined,
  );
  const billingFilter = and(
    userUuid ? eq(BillingUsageLedger.user_uuid, userUuid) : undefined,
    gte(BillingUsageLedger.created_at, from),
    to ? lte(BillingUsageLedger.created_at, to) : undefined,
    inArray(BillingUsageLedger.usage_type, ["stt_seconds", "tts_characters"]),
  );
  const [[files], [sessions], [tts], [billing]] = await Promise.all([
    db.select({
      total: sql<number>`count(*)::int`,
      success: sql<number>`count(*) filter (where ${SttTranscriptions.status} = 'completed')::int`,
      failed: sql<number>`count(*) filter (where ${SttTranscriptions.status} in ('failed', 'cancelled'))::int`,
      processing: sql<number>`count(*) filter (where ${SttTranscriptions.status} not in ('completed', 'failed', 'cancelled'))::int`,
      audioSeconds: sql<number>`coalesce(sum(${SttTranscriptions.audio_seconds}), 0)`,
    }).from(SttTranscriptions).where(sttFilter),
    db.select({
      total: sql<number>`count(*)::int`,
      success: sql<number>`count(*) filter (where ${SttSessions.status} = 'completed')::int`,
      failed: sql<number>`count(*) filter (where ${SttSessions.status} = 'failed')::int`,
      processing: sql<number>`count(*) filter (where ${SttSessions.status} not in ('completed', 'failed'))::int`,
      audioSeconds: sql<number>`coalesce(sum(${SttSessions.audio_duration_seconds}), 0)`,
    }).from(SttSessions).where(sessionFilter),
    db.select({
      total: sql<number>`count(*)::int`,
      success: sql<number>`count(*) filter (where ${TtsGenerations.status} = 'completed')::int`,
      failed: sql<number>`count(*) filter (where ${TtsGenerations.status} = 'failed')::int`,
      processing: sql<number>`count(*) filter (where ${TtsGenerations.status} not in ('completed', 'failed'))::int`,
      defaultVoice: sql<number>`count(*) filter (where ${TtsGenerations.voice_mode} = 'default')::int`,
      clonedVoice: sql<number>`count(*) filter (where ${TtsGenerations.voice_mode} = 'clone')::int`,
      inputCharacters: sql<number>`coalesce(sum(length(${TtsGenerations.input_text})), 0)::int`,
      outputBytes: sql<number>`coalesce(sum(${TtsGenerations.audio_size_bytes}), 0)`,
    }).from(TtsGenerations).where(ttsFilter),
    db.select({ credits: sql<number>`coalesce(sum(${BillingUsageLedger.charged_credits}), 0)` })
      .from(BillingUsageLedger).where(billingFilter),
  ]);
  const fileTotal = Number(files?.total ?? 0);
  const liveTotal = Number(sessions?.total ?? 0);
  const ttsTotal = Number(tts?.total ?? 0);
  const success = Number(files?.success ?? 0) + Number(sessions?.success ?? 0) + Number(tts?.success ?? 0);
  const failed = Number(files?.failed ?? 0) + Number(sessions?.failed ?? 0) + Number(tts?.failed ?? 0);
  const processing = Number(files?.processing ?? 0) + Number(sessions?.processing ?? 0) + Number(tts?.processing ?? 0);
  const total = fileTotal + liveTotal + ttsTotal;
  return {
    from,
    to: to ?? new Date(),
    totalRequests: total,
    successRequests: success,
    failedRequests: failed,
    processingRequests: processing,
    successRate: total ? (success / total) * 100 : 0,
    sttRequests: fileTotal + liveTotal,
    sttLiveSessions: liveTotal,
    sttFileTranscriptions: fileTotal,
    sttAudioSeconds: Number(files?.audioSeconds ?? 0) + Number(sessions?.audioSeconds ?? 0),
    ttsRequests: ttsTotal,
    ttsDefaultVoice: Number(tts?.defaultVoice ?? 0),
    ttsVoiceCloning: Number(tts?.clonedVoice ?? 0),
    ttsInputCharacters: Number(tts?.inputCharacters ?? 0),
    ttsOutputBytes: Number(tts?.outputBytes ?? 0),
    totalCredits: Number(billing?.credits ?? 0),
  };
};

export const getGpuOperationDetails = async (service: unknown, operationUuid: string) => {
  if (service !== "stt" && service !== "tts") return null;
  let domainRow: { operation: any; userEmail: string | null; userName: string | null } | undefined;
  let isLiveSession = false;
  if (service === "stt") {
    [domainRow] = await db.select({ operation: SttTranscriptions, userEmail: Users.email, userName: Users.fullName })
        .from(SttTranscriptions).leftJoin(Users, eq(SttTranscriptions.user_uuid, Users.user_uuid))
        .where(eq(SttTranscriptions.transcription_uuid, operationUuid)).limit(1);
    if (!domainRow) {
      isLiveSession = true;
      [domainRow] = await db.select({ operation: SttSessions, userEmail: Users.email, userName: Users.fullName })
        .from(SttSessions).leftJoin(Users, eq(SttSessions.user_uuid, Users.user_uuid))
        .where(eq(SttSessions.session_uuid, operationUuid)).limit(1);
    }
  } else {
    [domainRow] = await db.select({ operation: TtsGenerations, userEmail: Users.email, userName: Users.fullName })
        .from(TtsGenerations).leftJoin(Users, eq(TtsGenerations.user_uuid, Users.user_uuid))
        .where(eq(TtsGenerations.generation_uuid, operationUuid)).limit(1);
  }
  if (!domainRow) return null;

  const operation: any = domainRow.operation;
  const metadataId = service === "tts" ? "generationUuid" : isLiveSession ? "sessionUuid" : "transcriptionUuid";
  const usageRows = await db.select().from(BillingUsageLedger)
    .where(sql`${BillingUsageLedger.metadata}->>${metadataId} = ${operationUuid}`)
    .orderBy(desc(BillingUsageLedger.created_at));
  const requestIds = [...new Set([
    operation.request_id,
    ...usageRows.map((row) => row.request_id),
  ].filter((value): value is string => Boolean(value)))];
  const providerReferences = [...new Set([
    service === "stt" && !isLiveSession ? operation.provider_job_id : service === "tts" ? operation.provider_request_id : null,
    ...usageRows.map((row) => row.provider_reference),
  ].filter((value): value is string => Boolean(value)))];
  const gpuIdFilter = service === "stt" && !isLiveSession
    ? sql`${GpuServiceLogs.request_metadata}->>'transcriptionUuid' = ${operationUuid}`
    : undefined;
  const timeCorrelationFallback = service === "tts" && !requestIds.length && !providerReferences.length
    ? and(
        eq(GpuServiceLogs.user_uuid, operation.user_uuid),
        gte(GpuServiceLogs.created_at, new Date(operation.created_at.getTime() - 30_000)),
        lte(GpuServiceLogs.created_at, new Date((operation.completed_at ?? operation.updated_at).getTime() + 30_000)),
      )
    : undefined;
  const gpuLogs = await db.select().from(GpuServiceLogs).where(and(
    eq(GpuServiceLogs.service, service),
    or(
      requestIds.length ? inArray(GpuServiceLogs.request_id, requestIds) : undefined,
      providerReferences.length ? inArray(GpuServiceLogs.provider_reference, providerReferences) : undefined,
      gpuIdFilter,
      timeCorrelationFallback,
    ),
  )).orderBy(desc(GpuServiceLogs.created_at));
  const allRequestIds = [...new Set([
    ...requestIds,
    ...gpuLogs.map((log) => log.request_id).filter((value): value is string => Boolean(value)),
  ])];
  const apiLogs = allRequestIds.length
    ? await db.select().from(ApiTransactionLogs).where(inArray(ApiTransactionLogs.request_id, allRequestIds)).orderBy(desc(ApiTransactionLogs.created_at))
    : [];

  const createdAt: Date = operation.created_at;
  const completedAt: Date | null = operation.completed_at;
  const stages = [
    {
      id: `accepted:${operationUuid}`,
      type: "lifecycle",
      name: "Request accepted",
      status: "success",
      startedAt: createdAt,
      completedAt: createdAt,
      durationMs: 0,
      endpoint: null,
      description: `${service.toUpperCase()} operation was accepted and persisted`,
      request: service === "stt" && !isLiveSession
        ? { filename: operation.original_filename, contentType: operation.content_type, fileSizeBytes: operation.file_size_bytes, language: operation.language, diarize: operation.diarize, speakers: operation.speakers }
        : isLiveSession
          ? { language: operation.language, outputMode: operation.output_mode, sampleRate: operation.sample_rate, endSilenceMs: operation.end_silence_ms, partials: operation.partials }
        : { text: operation.input_text, characters: operation.input_text.length, language: operation.language, voiceMode: operation.voice_mode, outputFormat: operation.audio_format, speed: operation.speed, pitch: operation.pitch },
      response: { operationUuid, status: operation.status },
    },
    ...apiLogs.map((log) => ({
      id: `api:${log.log_uuid}`,
      type: "api",
      name: `${log.method} ${log.functionality}`,
      status: log.status,
      startedAt: new Date(log.created_at.getTime() - log.duration_ms),
      completedAt: log.created_at,
      durationMs: log.duration_ms,
      endpoint: log.path,
      description: log.description,
      request: log.request_metadata,
      response: log.response_metadata,
      httpStatus: log.http_status,
      errorCode: log.error_code,
      errorMessage: log.error_message,
    })),
    ...gpuLogs.map((log) => ({
      id: `gpu:${log.log_uuid}`,
      type: "gpu",
      name: `${log.service.toUpperCase()} ${log.operation.replaceAll("_", " ")}`,
      status: log.status,
      startedAt: new Date(log.created_at.getTime() - log.duration_ms),
      completedAt: log.created_at,
      durationMs: log.duration_ms,
      endpoint: log.endpoint,
      description: log.description,
      request: log.request_metadata,
      response: log.response_metadata,
      httpStatus: log.upstream_status,
      errorCode: log.error_code,
      errorMessage: log.error_message,
      artifactLogUuid: log.artifact_file_name ? log.log_uuid : null,
      artifactOriginalName: log.artifact_original_name,
    })),
    ...usageRows.map((usage) => ({
      id: `billing:${usage.usage_uuid}`,
      type: "billing",
      name: "Usage measured and credits charged",
      status: "success",
      startedAt: usage.created_at,
      completedAt: usage.created_at,
      durationMs: 0,
      endpoint: null,
      description: `${Number(usage.quantity)} ${usage.usage_type === "stt_seconds" ? "seconds" : usage.usage_type === "tts_characters" ? "characters" : "tokens"} × ${Number(usage.unit_price_credits)} credits`,
      request: { usageType: usage.usage_type, quantity: Number(usage.quantity), unitPriceCredits: Number(usage.unit_price_credits) },
      response: { chargedCredits: Number(usage.charged_credits), idempotencyKey: usage.idempotency_key },
    })),
    ...(completedAt ? [{
      id: `completed:${operationUuid}`,
      type: "lifecycle",
      name: operation.status === "completed" ? "Response ready" : "Operation closed",
      status: operation.status === "completed" ? "success" : "failed",
      startedAt: completedAt,
      completedAt,
      durationMs: 0,
      endpoint: null,
      description: operation.status === "completed" ? "The final result was persisted and made available to the user" : operation.error_message || `Operation ended with status ${operation.status}`,
      request: null,
      response: service === "stt" && !isLiveSession
        ? { status: operation.status, audioSeconds: operation.audio_seconds, transcriptCharacters: operation.transcript.length }
        : isLiveSession
          ? { status: operation.status, audioSeconds: operation.audio_duration_seconds, phrases: operation.phrase_count, transcriptCharacters: operation.transcript.length }
        : { status: operation.status, audioSizeBytes: operation.audio_size_bytes, format: operation.audio_format },
      errorCode: operation.error_code,
      errorMessage: operation.error_message,
    }] : []),
  ].sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());

  const billing = usageRows.map((row) => ({
    usageUuid: row.usage_uuid,
    usageType: row.usage_type,
    quantity: Number(row.quantity),
    unitPriceCredits: Number(row.unit_price_credits),
    chargedCredits: Number(row.charged_credits),
    metadata: row.metadata,
    createdAt: row.created_at,
  }));
  return {
    operation: {
      operationUuid,
      service,
      operationType: service === "tts" ? "generation" : isLiveSession ? "live session" : "transcription",
      status: operationStatus(operation.status),
      rawStatus: operation.status,
      userUuid: operation.user_uuid,
      userEmail: domainRow.userEmail,
      userName: domainRow.userName,
      requestId: operation.request_id,
      providerReference: service === "stt" && !isLiveSession ? operation.provider_job_id : service === "tts" ? operation.provider_request_id : null,
      createdAt,
      startedAt: operation.started_at ?? createdAt,
      completedAt,
      totalDurationMs: completedAt ? completedAt.getTime() - (operation.started_at ?? createdAt).getTime() : Date.now() - createdAt.getTime(),
      errorCode: operation.error_code,
      errorMessage: operation.error_message,
      metrics: service === "stt" && !isLiveSession
        ? { originalFilename: operation.original_filename, contentType: operation.content_type, uploadedBytes: operation.file_size_bytes, audioSeconds: operation.audio_seconds, transcriptCharacters: operation.transcript.length, language: operation.language }
        : isLiveSession
          ? { livePhrases: operation.phrase_count, audioSeconds: operation.audio_duration_seconds, transcriptCharacters: operation.transcript.length, sampleRate: operation.sample_rate, outputMode: operation.output_mode, language: operation.language }
        : { inputCharacters: operation.input_text.length, outputAudioBytes: operation.audio_size_bytes, outputFormat: operation.audio_format, language: operation.language, voiceMode: operation.voice_mode },
      input: service === "tts" ? { text: operation.input_text } : isLiveSession ? { mode: operation.output_mode, language: operation.language } : { filename: operation.original_filename },
      output: service === "tts" ? { audioFileName: operation.audio_file_name, mimeType: operation.audio_mime_type } : { transcript: operation.transcript, ...(!isLiveSession ? { result: operation.result_json } : {}) },
      resultAvailable: service === "stt" ? Boolean(operation.transcript) : Boolean(operation.audio_file_name && operation.status === "completed"),
    },
    billing: {
      items: billing,
      totalCredits: billing.reduce((sum, item) => sum + item.chargedCredits, 0),
    },
    stages,
    related: { apiCalls: apiLogs.length, gpuCalls: gpuLogs.length, billingEvents: usageRows.length },
  };
};

export const monitoredOperationResult = async (service: unknown, operationUuid: string) => {
  if (service === "stt") {
    const [transcription] = await db.select({ transcript: SttTranscriptions.transcript, originalName: SttTranscriptions.original_filename })
      .from(SttTranscriptions).where(eq(SttTranscriptions.transcription_uuid, operationUuid)).limit(1);
    let row: { transcript: string; originalName: string } | undefined = transcription;
    if (!row) {
      const [session] = await db.select({ transcript: SttSessions.transcript })
        .from(SttSessions).where(eq(SttSessions.session_uuid, operationUuid)).limit(1);
      if (session) row = { transcript: session.transcript, originalName: `live-session-${operationUuid}` };
    }
    if (!row?.transcript) return null;
    const baseName = path.basename(row.originalName, path.extname(row.originalName)).replace(/[^a-zA-Z0-9._-]/g, "_") || "transcription";
    return { kind: "text" as const, content: row.transcript, fileName: `${baseName}-transcript.txt`, contentType: "text/plain; charset=utf-8" };
  }
  if (service === "tts") {
    const [row] = await db.select().from(TtsGenerations).where(eq(TtsGenerations.generation_uuid, operationUuid)).limit(1);
    if (!row?.audio_file_name || row.status !== "completed") return null;
    const filePath = getTtsAudioPath(row.audio_file_name);
    try { await access(filePath); } catch { return null; }
    return { kind: "file" as const, path: filePath, fileName: row.audio_file_name, contentType: row.audio_mime_type ?? audioMimeTypeByFormat[row.audio_format] };
  }
  return null;
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
