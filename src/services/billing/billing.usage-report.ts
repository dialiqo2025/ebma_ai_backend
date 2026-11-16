import { and, eq, gte, ilike, or, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import {
  ApiTransactionLogs,
  BillingPlans,
  BillingSubscriptions,
  BillingUsageLedger,
  BillingWallets,
  SttSessions,
  SttTranscriptions,
  TtsGenerations,
  Users,
} from "../../schema";

export const usageReportModules = [
  "stt_file",
  "stt_live",
  "tts_default",
  "tts_clone",
  "assistant",
  "translation",
] as const;
export const usageReportStatuses = ["success", "failed", "queued", "processing", "stalled"] as const;
export type UsageReportModule = (typeof usageReportModules)[number];
export type UsageReportStatus = (typeof usageReportStatuses)[number];

export type UsageReportFilters = {
  from: Date;
  to: Date;
  timezone: string;
  search?: string;
  minCredits?: number;
  maxCredits?: number;
  module?: UsageReportModule;
  status?: UsageReportStatus;
};

type BillingRow = typeof BillingUsageLedger.$inferSelect;

export type UsageReportDetail = {
  createdAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  userUuid: string;
  fullName: string;
  email: string;
  projectUuid: string | null;
  apiKeyUuid: string | null;
  module: UsageReportModule;
  operation: string;
  status: UsageReportStatus;
  rawStatus: string;
  requestId: string | null;
  providerReference: string | null;
  httpStatus: number | null;
  inputQuantity: number;
  inputUnit: string;
  outputQuantity: number;
  outputUnit: string;
  billingQuantity: number;
  billingUnit: string;
  unitRateCredits: number;
  creditsUsed: number;
  errorCode: string | null;
  errorMessage: string | null;
  usageUuids: string[];
};

export type UsageReportSummary = {
  reportFrom: Date;
  reportTo: Date;
  timezone: string;
  userUuid: string;
  fullName: string;
  email: string;
  company: string | null;
  planName: string | null;
  walletBalanceCredits: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  queuedRequests: number;
  processingRequests: number;
  stalledRequests: number;
  successRate: number;
  sttFileRequests: number;
  sttLiveRequests: number;
  sttAudioSeconds: number;
  sttCredits: number;
  ttsDefaultRequests: number;
  ttsCloneRequests: number;
  ttsCharacters: number;
  ttsCredits: number;
  assistantRequests: number;
  assistantTokens: number;
  assistantCredits: number;
  translationRequests: number;
  totalCreditsUsed: number;
};

const number = (value: unknown) => Number(value ?? 0);
const stalledMinutes = () => {
  const configured = Number(process.env.GPU_OPERATION_STALLED_AFTER_MINUTES ?? 30);
  return Number.isFinite(configured) && configured >= 1 ? Math.min(Math.floor(configured), 10_080) : 30;
};

const operationStatus = (status: string, updatedAt: Date, terminal: string[]): UsageReportStatus => {
  if (status === "completed" || status === "success") return "success";
  if (["failed", "cancelled"].includes(status)) return "failed";
  if (!terminal.includes(status) && updatedAt < new Date(Date.now() - stalledMinutes() * 60_000)) return "stalled";
  if (["queued", "created", "connecting"].includes(status)) return "queued";
  return "processing";
};

const billingUnit = (type: BillingRow["usage_type"]) =>
  type === "stt_seconds" ? "seconds" : type === "tts_characters" ? "characters" : "tokens";

const billingModule = (type: BillingRow["usage_type"]): UsageReportModule =>
  type === "stt_seconds" ? "stt_file" : type === "tts_characters" ? "tts_default" : "assistant";

const operationUuid = (row: BillingRow) => {
  const metadata = row.metadata as Record<string, unknown> | null;
  for (const key of ["transcriptionUuid", "sessionUuid", "generationUuid"]) {
    if (typeof metadata?.[key] === "string") return metadata[key] as string;
  }
  return null;
};

const uniqueBillingRows = (...groups: Array<BillingRow[] | undefined>) => {
  const result = new Map<string, BillingRow>();
  for (const row of groups.flatMap((group) => group ?? [])) result.set(row.usage_uuid, row);
  return [...result.values()];
};

const billingValues = (rows: BillingRow[]) => ({
  billingQuantity: rows.reduce((sum, row) => sum + number(row.quantity), 0),
  billingUnit: rows.length ? billingUnit(rows[0]!.usage_type) : "",
  unitRateCredits: rows.length ? number(rows[0]!.unit_price_credits) : 0,
  creditsUsed: rows.reduce((sum, row) => sum + number(row.charged_credits), 0),
  usageUuids: rows.map((row) => row.usage_uuid),
});

const duration = (createdAt: Date, completedAt: Date | null) =>
  completedAt ? Math.max(0, completedAt.valueOf() - createdAt.valueOf()) : null;

const loadProfiles = async (search = "") => {
  const term = search.trim();
  return db
    .select({
      userUuid: Users.user_uuid,
      fullName: Users.fullName,
      email: Users.email,
      company: Users.company_name,
      walletBalance: BillingWallets.balance_credits,
      planName: sql<string | null>`(
        select ${BillingPlans.name}
        from ${BillingSubscriptions}
        left join ${BillingPlans} on ${BillingPlans.plan_uuid} = ${BillingSubscriptions.plan_uuid}
        where ${BillingSubscriptions.user_uuid} = ${Users.user_uuid}
        order by case when ${BillingSubscriptions.status} = 'active' then 0 else 1 end,
                 ${BillingSubscriptions.created_at} desc
        limit 1
      )`,
    })
    .from(Users)
    .leftJoin(BillingWallets, eq(BillingWallets.user_uuid, Users.user_uuid))
    .where(term ? or(ilike(Users.fullName, `%${term}%`), ilike(Users.email, `%${term}%`)) : undefined);
};

export const loadUsageReport = async (filters: UsageReportFilters) => {
  // Report windows are half-open so a boundary event is never included twice.
  const period = (column: typeof BillingUsageLedger.created_at) => and(gte(column, filters.from), sql`${column} < ${filters.to}`);
  const [profiles, billingRows, sttFiles, sttLive, ttsRows, apiRows] = await Promise.all([
    loadProfiles(filters.search),
    db.select().from(BillingUsageLedger).where(period(BillingUsageLedger.created_at)),
    db.select({ operation: SttTranscriptions, user: Users })
      .from(SttTranscriptions).innerJoin(Users, eq(SttTranscriptions.user_uuid, Users.user_uuid))
      .where(and(gte(SttTranscriptions.created_at, filters.from), sql`${SttTranscriptions.created_at} < ${filters.to}`)),
    db.select({ operation: SttSessions, user: Users })
      .from(SttSessions).innerJoin(Users, eq(SttSessions.user_uuid, Users.user_uuid))
      .where(and(gte(SttSessions.created_at, filters.from), sql`${SttSessions.created_at} < ${filters.to}`)),
    db.select({ operation: TtsGenerations, user: Users })
      .from(TtsGenerations).innerJoin(Users, eq(TtsGenerations.user_uuid, Users.user_uuid))
      .where(and(gte(TtsGenerations.created_at, filters.from), sql`${TtsGenerations.created_at} < ${filters.to}`)),
    db.select({ log: ApiTransactionLogs, user: Users })
      .from(ApiTransactionLogs).innerJoin(Users, eq(ApiTransactionLogs.user_uuid, Users.user_uuid))
      .where(and(
        gte(ApiTransactionLogs.created_at, filters.from),
        sql`${ApiTransactionLogs.created_at} < ${filters.to}`,
        eq(ApiTransactionLogs.method, "POST"),
        or(
          and(eq(ApiTransactionLogs.module, "chat"), ilike(ApiTransactionLogs.path, "%/chat/messages%")),
          and(eq(ApiTransactionLogs.module, "llm"), ilike(ApiTransactionLogs.path, "%/llm/process%")),
          and(eq(ApiTransactionLogs.module, "translate"), or(
            ilike(ApiTransactionLogs.path, "%/translate/text%"),
            ilike(ApiTransactionLogs.path, "%/translate/documents%"),
          )),
        ),
      )),
  ]);

  const allowedUsers = new Set(profiles.map((profile) => profile.userUuid));
  const byRequest = new Map<string, BillingRow[]>();
  const byOperation = new Map<string, BillingRow[]>();
  for (const row of billingRows) {
    if (row.request_id) byRequest.set(row.request_id, [...(byRequest.get(row.request_id) ?? []), row]);
    const uuid = operationUuid(row);
    if (uuid) byOperation.set(uuid, [...(byOperation.get(uuid) ?? []), row]);
  }
  const matchedUsage = new Set<string>();
  const details: UsageReportDetail[] = [];
  const add = (detail: Omit<UsageReportDetail, "billingQuantity" | "billingUnit" | "unitRateCredits" | "creditsUsed" | "usageUuids">, rows: BillingRow[]) => {
    rows.forEach((row) => matchedUsage.add(row.usage_uuid));
    details.push({ ...detail, ...billingValues(rows) });
  };

  for (const { operation, user } of sttFiles) {
    const rows = uniqueBillingRows(byOperation.get(operation.transcription_uuid), operation.request_id ? byRequest.get(operation.request_id) : undefined);
    add({
      createdAt: operation.created_at, completedAt: operation.completed_at,
      durationMs: duration(operation.created_at, operation.completed_at), userUuid: operation.user_uuid,
      fullName: user.fullName, email: user.email, projectUuid: operation.project_uuid, apiKeyUuid: operation.api_key_uuid,
      module: "stt_file", operation: "file_transcription",
      status: operationStatus(operation.status, operation.updated_at, ["completed", "failed", "cancelled"]), rawStatus: operation.status,
      requestId: operation.request_id, providerReference: operation.provider_job_id, httpStatus: null,
      inputQuantity: number(operation.audio_seconds), inputUnit: "audio_seconds",
      outputQuantity: operation.transcript.length, outputUnit: "transcript_characters",
      errorCode: operation.error_code, errorMessage: operation.error_message,
    }, rows);
  }

  for (const { operation, user } of sttLive) {
    const rows = uniqueBillingRows(byOperation.get(operation.session_uuid), operation.request_id ? byRequest.get(operation.request_id) : undefined);
    add({
      createdAt: operation.created_at, completedAt: operation.completed_at,
      durationMs: duration(operation.created_at, operation.completed_at), userUuid: operation.user_uuid,
      fullName: user.fullName, email: user.email, projectUuid: operation.project_uuid, apiKeyUuid: operation.api_key_uuid,
      module: "stt_live", operation: "live_transcription",
      status: operationStatus(operation.status, operation.updated_at, ["completed", "failed"]), rawStatus: operation.status,
      requestId: operation.request_id, providerReference: null, httpStatus: null,
      inputQuantity: number(operation.audio_duration_seconds), inputUnit: "audio_seconds",
      outputQuantity: operation.transcript.length, outputUnit: "transcript_characters",
      errorCode: operation.error_code, errorMessage: operation.error_message,
    }, rows);
  }

  for (const { operation, user } of ttsRows) {
    const rows = uniqueBillingRows(byOperation.get(operation.generation_uuid), operation.request_id ? byRequest.get(operation.request_id) : undefined);
    add({
      createdAt: operation.created_at, completedAt: operation.completed_at,
      durationMs: duration(operation.created_at, operation.completed_at), userUuid: operation.user_uuid,
      fullName: user.fullName, email: user.email, projectUuid: operation.project_uuid, apiKeyUuid: operation.api_key_uuid,
      module: operation.voice_mode === "clone" ? "tts_clone" : "tts_default",
      operation: operation.voice_mode === "clone" ? "voice_clone_generation" : "default_voice_generation",
      status: operationStatus(operation.status, operation.updated_at, ["completed", "failed"]), rawStatus: operation.status,
      requestId: operation.request_id, providerReference: operation.provider_request_id, httpStatus: null,
      inputQuantity: operation.input_text.length, inputUnit: "input_characters",
      outputQuantity: number(operation.audio_size_bytes), outputUnit: "audio_bytes",
      errorCode: operation.error_code, errorMessage: operation.error_message,
    }, rows);
  }

  for (const { log, user } of apiRows) {
    const rows = uniqueBillingRows(byRequest.get(log.request_id));
    const isTranslation = log.module === "translate";
    add({
      createdAt: log.created_at,
      completedAt: new Date(log.created_at.valueOf() + log.duration_ms), durationMs: log.duration_ms,
      userUuid: log.user_uuid!, fullName: user.fullName, email: user.email, projectUuid: null,
      apiKeyUuid: log.api_key_uuid, module: isTranslation ? "translation" : "assistant",
      operation: isTranslation ? (log.path.includes("/documents") ? "document_translation" : "text_translation") : log.module === "chat" ? "assistant_message" : "llm_process",
      status: log.status === "success" ? "success" : "failed", rawStatus: log.status,
      requestId: log.request_id, providerReference: null, httpStatus: log.http_status,
      inputQuantity: 0, inputUnit: "", outputQuantity: 0, outputUnit: "",
      errorCode: log.error_code, errorMessage: log.error_message,
    }, rows);
  }

  // Preserve every charge even when historical records lack operation correlation.
  const profileByUser = new Map(profiles.map((profile) => [profile.userUuid, profile]));
  for (const row of billingRows) {
    if (matchedUsage.has(row.usage_uuid)) continue;
    const profile = profileByUser.get(row.user_uuid);
    if (!profile) continue;
    add({
      createdAt: row.created_at, completedAt: row.created_at, durationMs: null,
      userUuid: row.user_uuid, fullName: profile.fullName, email: profile.email,
      projectUuid: row.project_uuid, apiKeyUuid: row.api_key_uuid,
      module: billingModule(row.usage_type), operation: "billing_usage",
      status: "success", rawStatus: "billed", requestId: row.request_id,
      providerReference: row.provider_reference, httpStatus: null,
      inputQuantity: number(row.quantity), inputUnit: billingUnit(row.usage_type),
      outputQuantity: 0, outputUnit: "", errorCode: null, errorMessage: null,
    }, [row]);
  }

  const visibleDetails = details.filter((detail) =>
    allowedUsers.has(detail.userUuid) &&
    (!filters.module || detail.module === filters.module) &&
    (!filters.status || detail.status === filters.status));

  const detailsByUser = new Map<string, UsageReportDetail[]>();
  for (const detail of visibleDetails) detailsByUser.set(detail.userUuid, [...(detailsByUser.get(detail.userUuid) ?? []), detail]);

  const summaries = profiles.map((profile): UsageReportSummary => {
    const rows = detailsByUser.get(profile.userUuid) ?? [];
    const count = (predicate: (row: UsageReportDetail) => boolean) => rows.filter(predicate).length;
    const credits = (predicate: (row: UsageReportDetail) => boolean) => rows.filter(predicate).reduce((sum, row) => sum + row.creditsUsed, 0);
    const successful = count((row) => row.status === "success");
    const stt = (row: UsageReportDetail) => row.module === "stt_file" || row.module === "stt_live";
    const tts = (row: UsageReportDetail) => row.module === "tts_default" || row.module === "tts_clone";
    const totalCredits = rows.reduce((sum, row) => sum + row.creditsUsed, 0);
    return {
      reportFrom: filters.from, reportTo: filters.to, timezone: filters.timezone,
      userUuid: profile.userUuid, fullName: profile.fullName, email: profile.email,
      company: profile.company, planName: profile.planName, walletBalanceCredits: number(profile.walletBalance),
      totalRequests: rows.length, successfulRequests: successful,
      failedRequests: count((row) => row.status === "failed"), queuedRequests: count((row) => row.status === "queued"),
      processingRequests: count((row) => row.status === "processing"), stalledRequests: count((row) => row.status === "stalled"),
      successRate: rows.length ? (successful / rows.length) * 100 : 0,
      sttFileRequests: count((row) => row.module === "stt_file"), sttLiveRequests: count((row) => row.module === "stt_live"),
      sttAudioSeconds: rows.filter(stt).reduce((sum, row) => sum + (row.inputUnit === "audio_seconds" || row.inputUnit === "seconds" ? row.inputQuantity : row.billingQuantity), 0),
      sttCredits: credits(stt), ttsDefaultRequests: count((row) => row.module === "tts_default"),
      ttsCloneRequests: count((row) => row.module === "tts_clone"),
      ttsCharacters: rows.filter(tts).reduce((sum, row) => sum + (row.inputUnit === "input_characters" || row.inputUnit === "characters" ? row.inputQuantity : row.billingQuantity), 0),
      ttsCredits: credits(tts), assistantRequests: count((row) => row.module === "assistant"),
      assistantTokens: rows.filter((row) => row.module === "assistant").reduce((sum, row) => sum + row.billingQuantity, 0),
      assistantCredits: credits((row) => row.module === "assistant"),
      translationRequests: count((row) => row.module === "translation"), totalCreditsUsed: totalCredits,
    };
  }).filter((summary) =>
    (filters.minCredits === undefined || summary.totalCreditsUsed >= filters.minCredits) &&
    (filters.maxCredits === undefined || summary.totalCreditsUsed <= filters.maxCredits));

  const includedUsers = new Set(summaries.map((summary) => summary.userUuid));
  return {
    summaries: summaries.sort((a, b) => b.totalCreditsUsed - a.totalCreditsUsed || a.fullName.localeCompare(b.fullName)),
    details: visibleDetails.filter((detail) => includedUsers.has(detail.userUuid)).sort((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf()),
  };
};

const csvCell = (input: unknown) => {
  let value = input === null || input === undefined ? "" : String(input);
  if (/^[=+\-@\t\r]/.test(value)) value = `'${value}`;
  return `"${value.replaceAll('"', '""')}"`;
};

const csv = (headers: string[], rows: unknown[][]) => Buffer.from(
  `\uFEFF${headers.map(csvCell).join(",")}\r\n${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`,
  "utf8",
);

const formatDate = (date: Date | null, timezone: string) => date ? new Intl.DateTimeFormat("en-CA", {
  timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).format(date).replace(",", "") : "";

export const buildUsageSummaryCsv = (rows: UsageReportSummary[]) => {
  const headers = [
    "report_from", "report_to", "timezone", "user_uuid", "full_name", "email", "company", "plan_name", "wallet_balance_credits",
    "total_requests", "successful_requests", "failed_requests", "queued_requests", "processing_requests", "stalled_requests", "success_rate_percent",
    "stt_file_requests", "stt_live_requests", "stt_audio_seconds", "stt_credits", "tts_default_requests", "tts_clone_requests", "tts_characters", "tts_credits",
    "assistant_requests", "assistant_tokens", "assistant_credits", "translation_requests", "total_credits_used",
  ];
  return csv(headers, rows.map((row) => [
    formatDate(row.reportFrom, row.timezone), formatDate(row.reportTo, row.timezone), row.timezone, row.userUuid, row.fullName, row.email,
    row.company, row.planName, row.walletBalanceCredits, row.totalRequests, row.successfulRequests, row.failedRequests, row.queuedRequests,
    row.processingRequests, row.stalledRequests, row.successRate.toFixed(2), row.sttFileRequests, row.sttLiveRequests, row.sttAudioSeconds,
    row.sttCredits, row.ttsDefaultRequests, row.ttsCloneRequests, row.ttsCharacters, row.ttsCredits, row.assistantRequests,
    row.assistantTokens, row.assistantCredits, row.translationRequests, row.totalCreditsUsed,
  ]));
};

export const buildUsageDetailsCsv = (rows: UsageReportDetail[], timezone: string) => {
  const headers = [
    "created_at", "completed_at", "timezone", "duration_ms", "user_uuid", "full_name", "email", "project_uuid", "api_key_uuid",
    "module", "operation", "status", "raw_status", "request_id", "provider_reference", "http_status", "input_quantity", "input_unit",
    "output_quantity", "output_unit", "billing_quantity", "billing_unit", "unit_rate_credits", "credits_used", "error_code", "error_message",
  ];
  return csv(headers, rows.map((row) => [
    formatDate(row.createdAt, timezone), formatDate(row.completedAt, timezone), timezone, row.durationMs, row.userUuid, row.fullName, row.email,
    row.projectUuid, row.apiKeyUuid, row.module, row.operation, row.status, row.rawStatus, row.requestId, row.providerReference, row.httpStatus,
    row.inputQuantity, row.inputUnit, row.outputQuantity, row.outputUnit, row.billingQuantity, row.billingUnit, row.unitRateCredits,
    row.creditsUsed, row.errorCode, row.errorMessage,
  ]));
};

