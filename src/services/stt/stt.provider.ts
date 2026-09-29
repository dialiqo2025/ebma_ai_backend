import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { SttSegments, SttSessions, SttTranscriptions } from "../../schema";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import { GenResObj } from "../../utils/responseFormat.util";
import { prepareTextForTts } from "../llm/llm.provider";
import { recordUsage } from "../billing/billing.provider";
import {
  isSttModelConfigured,
  mapProviderTranscriptionStatus,
  maxUploadBytes,
  serializeSttSegment,
  serializeSttSession,
  serializeSttTranscription,
  STT_LANGUAGES,
  toSttStartMessage,
} from "./stt.helper";
import {
  createTranscriptionJob,
  deleteTranscriptionJob,
  downloadTranscriptionJob,
  getSttModelHealth,
  getTranscriptionJob,
  requestSttBrowserToken,
  SttModelError,
} from "./stt.model";
import type {
  CreateSttSession,
  CreateSttTranscription,
  FinishSttSession,
  ListSttSessions,
  ListSttTranscriptions,
  SttFinalSegment,
  SttTokenRequest,
  UpdateSttSession,
} from "./stt.validate";

const findOwnedSession = async (sessionUuid: string, userUuid: string) => {
  const [session] = await db
    .select()
    .from(SttSessions)
    .where(
      and(
        eq(SttSessions.session_uuid, sessionUuid),
        eq(SttSessions.user_uuid, userUuid),
      ),
    )
    .limit(1);

  return session;
};

export const createSttSession = async (userUuid: string, payload: CreateSttSession) => {
  const [session] = await db
    .insert(SttSessions)
    .values({
      user_uuid: userUuid,
      language: payload.language,
      output_mode: payload.mode,
      sample_rate: payload.sampleRate,
      end_silence_ms: payload.endSilenceMs,
      partials: payload.partials,
    })
    .returning();

  if (!session) throw new Error("STT session creation failed");

  return GenResObj(
    Code.CREATED,
    true,
    "STT session created successfully",
    {
      ...serializeSttSession(session),
      startMessage: toSttStartMessage(session),
    },
  );
};

export const listSttSessions = async (userUuid: string, query: ListSttSessions) => {
  const offset = (query.page - 1) * query.page_size;
  const filters = and(
    eq(SttSessions.user_uuid, userUuid),
    query.status ? eq(SttSessions.status, query.status) : undefined,
    query.language ? eq(SttSessions.language, query.language) : undefined,
    query.search ? ilike(SttSessions.transcript, `%${query.search}%`) : undefined,
  );

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(SttSessions)
    .where(filters);

  const sessions = await db
    .select()
    .from(SttSessions)
    .where(filters)
    .orderBy(desc(SttSessions.created_at))
    .limit(query.page_size)
    .offset(offset);

  const totalCount = Number(countRow?.count ?? 0);
  const totalPages = Math.ceil(totalCount / query.page_size);

  return GenResObj(Code.OK, true, "STT sessions fetched successfully", {
    items: sessions.map((session) => serializeSttSession(session)),
    pagination: {
      page: query.page,
      pageSize: query.page_size,
      totalCount,
      totalPages,
      hasNextPage: query.page < totalPages,
    },
  });
};

export const getSttSession = async (sessionUuid: string, userUuid: string) => {
  const session = await findOwnedSession(sessionUuid, userUuid);
  if (!session) return GenResObj(Code.NOT_FOUND, false, "STT session not found");

  const segments = await db
    .select()
    .from(SttSegments)
    .where(eq(SttSegments.session_uuid, sessionUuid))
    .orderBy(asc(SttSegments.segment_index));

  return GenResObj(
    Code.OK,
    true,
    "STT session fetched successfully",
    serializeSttSession(session, segments),
  );
};

export const updateSttSession = async (
  sessionUuid: string,
  userUuid: string,
  payload: UpdateSttSession,
) => {
  const existing = await findOwnedSession(sessionUuid, userUuid);
  if (!existing) return GenResObj(Code.NOT_FOUND, false, "STT session not found");

  if (existing.status === "failed" && existing.phrase_count > 0) {
    return GenResObj(
      Code.CONFLICT,
      false,
      "A failed session containing transcript segments is immutable; create a new session",
    );
  }

  if (existing.status !== "created" && existing.status !== "failed") {
    return GenResObj(
      Code.CONFLICT,
      false,
      "Only created or failed STT sessions can be edited",
    );
  }

  const [updated] = await db
    .update(SttSessions)
    .set({
      ...(payload.language !== undefined ? { language: payload.language } : {}),
      ...(payload.mode !== undefined ? { output_mode: payload.mode } : {}),
      ...(payload.sampleRate !== undefined ? { sample_rate: payload.sampleRate } : {}),
      ...(payload.endSilenceMs !== undefined
        ? { end_silence_ms: payload.endSilenceMs }
        : {}),
      ...(payload.partials !== undefined ? { partials: payload.partials } : {}),
      status: "created",
      error_code: null,
      error_message: null,
      completed_at: null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(SttSessions.session_uuid, sessionUuid),
        eq(SttSessions.user_uuid, userUuid),
      ),
    )
    .returning();

  if (!updated) throw new Error("STT session update failed");

  return GenResObj(Code.OK, true, "STT session updated successfully", {
    ...serializeSttSession(updated),
    startMessage: toSttStartMessage(updated),
  });
};

export const deleteSttSession = async (sessionUuid: string, userUuid: string) => {
  const existing = await findOwnedSession(sessionUuid, userUuid);
  if (!existing) return GenResObj(Code.NOT_FOUND, false, "STT session not found");

  if (existing.status === "connecting" || existing.status === "streaming") {
    return GenResObj(
      Code.CONFLICT,
      false,
      "Finish the active STT session before deleting it",
    );
  }

  const [deleted] = await db
    .delete(SttSessions)
    .where(
      and(
        eq(SttSessions.session_uuid, sessionUuid),
        eq(SttSessions.user_uuid, userUuid),
      ),
    )
    .returning();

  if (!deleted) throw new Error("STT session deletion failed");

  return GenResObj(Code.OK, true, "STT session deleted successfully", { sessionUuid });
};

export const createSttBrowserToken = async (
  sessionUuid: string,
  userUuid: string,
  payload: SttTokenRequest,
) => {
  const session = await findOwnedSession(sessionUuid, userUuid);
  if (!session) return GenResObj(Code.NOT_FOUND, false, "STT session not found");

  if (session.status === "streaming" || session.status === "completed") {
    return GenResObj(
      Code.CONFLICT,
      false,
      session.status === "streaming"
        ? "STT session is already streaming"
        : "STT session is already completed",
    );
  }

  if (session.status === "failed" && session.phrase_count > 0) {
    return GenResObj(
      Code.CONFLICT,
      false,
      "Create a new session to continue after a failed stream",
    );
  }

  try {
    const token = await requestSttBrowserToken({
      subject: userUuid,
      ttlSeconds: payload.ttlSeconds,
      language: session.language,
    });

    const [updated] = await db
      .update(SttSessions)
      .set({
        status: "connecting",
        error_code: null,
        error_message: null,
        completed_at: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(SttSessions.session_uuid, sessionUuid),
          eq(SttSessions.user_uuid, userUuid),
        ),
      )
      .returning();

    if (!updated) throw new Error("STT session token update failed");

    return GenResObj(Code.OK, true, "STT browser token created successfully", {
      session: serializeSttSession(updated),
      connection: {
        token: token.token,
        wsUrl: token.ws_url,
        expiresIn: token.expires_in,
        expiresAt: token.expires_at,
      },
      startMessage: toSttStartMessage(updated),
    });
  } catch (error) {
    const modelError =
      error instanceof SttModelError
        ? error
        : new SttModelError("STT token creation failed", "token_creation_failed", 500);

    const [failed] = await db
      .update(SttSessions)
      .set({
        status: "failed",
        error_code: modelError.code,
        error_message: modelError.message,
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(SttSessions.session_uuid, sessionUuid),
          eq(SttSessions.user_uuid, userUuid),
        ),
      )
      .returning();

    if (!(error instanceof SttModelError)) {
      console.error("Unexpected STT token error:", error);
    }

    return GenResObj(
      modelError.httpStatus,
      false,
      modelError.message,
      failed ? serializeSttSession(failed) : undefined,
    );
  }
};

export const markSttSessionStarted = async (sessionUuid: string, userUuid: string) => {
  const session = await findOwnedSession(sessionUuid, userUuid);
  if (!session) return GenResObj(Code.NOT_FOUND, false, "STT session not found");

  if (session.status !== "connecting") {
    return GenResObj(
      Code.CONFLICT,
      false,
      "STT session must have a valid connection token before it can start",
    );
  }

  const [updated] = await db
    .update(SttSessions)
    .set({ status: "streaming", started_at: new Date(), updated_at: new Date() })
    .where(
      and(
        eq(SttSessions.session_uuid, sessionUuid),
        eq(SttSessions.user_uuid, userUuid),
        eq(SttSessions.status, "connecting"),
      ),
    )
    .returning();

  if (!updated) return GenResObj(Code.CONFLICT, false, "STT session could not be started");

  return GenResObj(
    Code.OK,
    true,
    "STT session started successfully",
    serializeSttSession(updated),
  );
};

export const addSttFinalSegment = async (
  sessionUuid: string,
  userUuid: string,
  payload: SttFinalSegment,
) => {
  const session = await findOwnedSession(sessionUuid, userUuid);
  if (!session) return GenResObj(Code.NOT_FOUND, false, "STT session not found");

  if (session.status !== "connecting" && session.status !== "streaming") {
    return GenResObj(Code.CONFLICT, false, "STT session is not active");
  }

  const result = await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${sessionUuid}))`,
    );

    const [inserted] = await transaction
      .insert(SttSegments)
      .values({
        session_uuid: sessionUuid,
        segment_index: payload.seg,
        text: payload.text,
        language: payload.lang,
        start_seconds: payload.t0,
        end_seconds: payload.t1,
        audio_seconds: payload.audio_s,
        decode_ms: payload.decode_ms,
        latency_ms: payload.latency_ms,
        reason: payload.reason,
      })
      .onConflictDoNothing({
        target: [SttSegments.session_uuid, SttSegments.segment_index],
      })
      .returning();

    if (!inserted) {
      const [existingSegment] = await transaction
        .select()
        .from(SttSegments)
        .where(
          and(
            eq(SttSegments.session_uuid, sessionUuid),
            eq(SttSegments.segment_index, payload.seg),
          ),
        )
        .limit(1);

      return { duplicate: true, segment: existingSegment, session };
    }

    const segments = await transaction
      .select()
      .from(SttSegments)
      .where(eq(SttSegments.session_uuid, sessionUuid))
      .orderBy(asc(SttSegments.segment_index));

    const transcript = segments.map((segment) => segment.text).join(" ");
    const audioDurationSeconds = segments.reduce(
      (total, segment) => total + segment.audio_seconds,
      0,
    );

    const llmPreparedText = process.env.LLM_MODEL_ENDPOINT && process.env.LLM_API_KEY
      ? (await prepareTextForTts({
          text: transcript,
          language: session.language,
          style: "natural",
        })).data?.data?.text
      : transcript;

    const [updatedSession] = await transaction
      .update(SttSessions)
      .set({
        status: "streaming",
        transcript: typeof llmPreparedText === "string" ? llmPreparedText : transcript,
        phrase_count: segments.length,
        audio_duration_seconds: audioDurationSeconds,
        started_at: session.started_at ?? new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(SttSessions.session_uuid, sessionUuid),
          eq(SttSessions.user_uuid, userUuid),
        ),
      )
      .returning();

    if (!updatedSession) throw new Error("STT session aggregation failed");
    return { duplicate: false, segment: inserted, session: updatedSession };
  });

  if (!result.segment) throw new Error("STT segment persistence failed");

  if (!result.duplicate) {
    void recordUsage({
      userUuid,
      type: "stt_seconds",
      quantity: Number(result.segment.audio_seconds),
      idempotencyKey: `stt:${sessionUuid}:${payload.seg}`,
      metadata: { sessionUuid, language: payload.lang },
    });
  }

  return GenResObj(
    result.duplicate ? Code.OK : Code.CREATED,
    true,
    result.duplicate
      ? "STT final segment was already saved"
      : "STT final segment saved successfully",
    {
      segment: serializeSttSegment(result.segment),
      session: serializeSttSession(result.session),
    },
  );
};

export const finishSttSession = async (
  sessionUuid: string,
  userUuid: string,
  payload: FinishSttSession,
) => {
  const session = await findOwnedSession(sessionUuid, userUuid);
  if (!session) return GenResObj(Code.NOT_FOUND, false, "STT session not found");

  if (session.status === "completed") {
    return GenResObj(
      Code.OK,
      true,
      "STT session was already completed",
      serializeSttSession(session),
    );
  }

  const [updated] = await db
    .update(SttSessions)
    .set({
      status: payload.status,
      error_code: payload.status === "failed" ? payload.errorCode ?? null : null,
      error_message: payload.status === "failed" ? payload.errorMessage ?? null : null,
      completed_at: new Date(),
      updated_at: new Date(),
    })
    .where(
      and(
        eq(SttSessions.session_uuid, sessionUuid),
        eq(SttSessions.user_uuid, userUuid),
      ),
    )
    .returning();

  if (!updated) throw new Error("STT session completion failed");

  return GenResObj(
    Code.OK,
    true,
    payload.status === "completed"
      ? "STT session completed successfully"
      : "STT session marked as failed",
    serializeSttSession(updated),
  );
};

export const getSttHealth = async () => {
  try {
    const health = await getSttModelHealth();
    return GenResObj(Code.OK, true, "EBMA ASR backend is healthy", health);
  } catch (error) {
    const modelError =
      error instanceof SttModelError
        ? error
        : new SttModelError("STT health check failed", "health_check_failed", 500);

    return GenResObj(modelError.httpStatus, false, modelError.message);
  }
};

export const getSttOptions = () =>
  GenResObj(Code.OK, true, "STT options fetched successfully", {
    languages: STT_LANGUAGES,
    modes: ["native", "mixed", "romanized"],
    sampleRate: { min: 8000, max: 96000, default: 16000 },
    endSilenceMs: { min: 250, max: 3000, default: 700 },
    partialsDefault: true,
    maxSessionMinutes: 20,
    maxPhraseSeconds: 25,
    modelConfigured: isSttModelConfigured(),
    transport: "websocket",
    audio: {
      encoding: "pcm_s16le",
      channels: 1,
      recommendedFrameMs: { min: 20, max: 100, ideal: 50 },
    },
    fileTranscription: {
      enabled: true,
      maxUploadBytes: maxUploadBytes(),
      maxAudioMinutes: 120,
      acceptedFormats: [
        "wav",
        "mp3",
        "m4a",
        "aac",
        "flac",
        "ogg",
        "opus",
        "webm",
        "mp4",
      ],
      downloadFormats: ["txt", "srt", "vtt"],
      diarizeDefault: false,
      speakers: { min: 1, max: 20 },
      pollIntervalMs: 1500,
    },
  });

const findOwnedTranscription = async (
  transcriptionUuid: string,
  userUuid: string,
) => {
  const [row] = await db
    .select()
    .from(SttTranscriptions)
    .where(
      and(
        eq(SttTranscriptions.transcription_uuid, transcriptionUuid),
        eq(SttTranscriptions.user_uuid, userUuid),
      ),
    )
    .limit(1);

  return row;
};

const applyProviderJobSnapshot = async (
  row: typeof SttTranscriptions.$inferSelect,
  job: Record<string, unknown>,
) => {
  const status = mapProviderTranscriptionStatus(job.status);
  const result =
    status === "completed" && job.result && typeof job.result === "object"
      ? (job.result as Record<string, unknown>)
      : null;
  const error =
    job.error && typeof job.error === "object"
      ? (job.error as { code?: string; message?: string })
      : null;

  const [updated] = await db
    .update(SttTranscriptions)
    .set({
      status,
      stage: typeof job.stage === "string" ? job.stage : row.stage,
      progress:
        typeof job.progress === "number"
          ? Math.max(0, Math.min(1, job.progress))
          : row.progress,
      audio_seconds:
        typeof job.audio_seconds === "number"
          ? job.audio_seconds
          : typeof result?.duration_s === "number"
            ? result.duration_s
            : row.audio_seconds,
      transcript:
        typeof result?.text === "string"
          ? result.text
          : status === "completed"
            ? row.transcript
            : row.transcript,
      result_json: result ?? row.result_json,
      error_code:
        status === "failed" ? error?.code ?? row.error_code ?? "transcription_failed" : null,
      error_message:
        status === "failed"
          ? error?.message ?? row.error_message ?? "Transcription failed"
          : null,
      completed_at:
        status === "completed" || status === "failed" || status === "cancelled"
          ? row.completed_at ?? new Date()
          : null,
      updated_at: new Date(),
    })
    .where(eq(SttTranscriptions.transcription_uuid, row.transcription_uuid))
    .returning();

  return updated ?? row;
};

export const createSttTranscription = async (
  userUuid: string,
  payload: CreateSttTranscription,
  file: Express.Multer.File,
) => {
  if (!file?.buffer?.length) {
    return GenResObj(Code.BAD_REQUEST, false, "Audio file is required");
  }

  if (file.size > maxUploadBytes()) {
    return GenResObj(Code.REQUEST_TOO_LONG, false, "Uploaded file exceeds the size limit");
  }

  try {
    const created = await createTranscriptionJob({
      file: file.buffer,
      filename: file.originalname || "recording",
      contentType: file.mimetype,
      language: payload.language,
      diarize: payload.diarize,
      ...(payload.speakers !== undefined ? { speakers: payload.speakers } : {}),
    });

    const [row] = await db
      .insert(SttTranscriptions)
      .values({
        user_uuid: userUuid,
        provider_job_id: created.job_id,
        original_filename: file.originalname || "recording",
        content_type: file.mimetype || null,
        file_size_bytes: file.size,
        language: payload.language,
        diarize: payload.diarize,
        speakers: payload.speakers ?? null,
        status: mapProviderTranscriptionStatus(created.status ?? "queued"),
      })
      .returning();

    if (!row) throw new Error("STT transcription creation failed");

    return GenResObj(
      Code.ACCEPTED,
      true,
      "Transcription job started successfully",
      serializeSttTranscription(row),
    );
  } catch (error) {
    const modelError =
      error instanceof SttModelError
        ? error
        : new SttModelError(
            "STT transcription upload failed",
            "transcription_upload_failed",
            500,
          );

    if (!(error instanceof SttModelError)) {
      console.error("Unexpected STT transcription upload error:", error);
    }

    return GenResObj(modelError.httpStatus, false, modelError.message, {
      error: { code: modelError.code, message: modelError.message },
    });
  }
};

export const listSttTranscriptions = async (
  userUuid: string,
  query: ListSttTranscriptions,
) => {
  const offset = (query.page - 1) * query.page_size;
  const filters = and(
    eq(SttTranscriptions.user_uuid, userUuid),
    query.status ? eq(SttTranscriptions.status, query.status) : undefined,
    query.language ? eq(SttTranscriptions.language, query.language) : undefined,
    query.search
      ? ilike(SttTranscriptions.original_filename, `%${query.search}%`)
      : undefined,
  );

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(SttTranscriptions)
    .where(filters);

  const rows = await db
    .select()
    .from(SttTranscriptions)
    .where(filters)
    .orderBy(desc(SttTranscriptions.created_at))
    .limit(query.page_size)
    .offset(offset);

  const totalCount = Number(countRow?.count ?? 0);
  const totalPages = Math.ceil(totalCount / query.page_size);

  return GenResObj(Code.OK, true, "STT transcriptions fetched successfully", {
    items: rows.map(serializeSttTranscription),
    pagination: {
      page: query.page,
      pageSize: query.page_size,
      totalCount,
      totalPages,
      hasNextPage: query.page < totalPages,
    },
  });
};

export const getSttTranscription = async (
  transcriptionUuid: string,
  userUuid: string,
) => {
  const row = await findOwnedTranscription(transcriptionUuid, userUuid);
  if (!row) return GenResObj(Code.NOT_FOUND, false, "STT transcription not found");

  if (row.status === "queued" || row.status === "processing") {
    try {
      const job = await getTranscriptionJob(row.provider_job_id);
      const synced = await applyProviderJobSnapshot(row, job);
      return GenResObj(
        Code.OK,
        true,
        "STT transcription fetched successfully",
        serializeSttTranscription(synced),
      );
    } catch (error) {
      if (error instanceof SttModelError && error.httpStatus === 404) {
        const [failed] = await db
          .update(SttTranscriptions)
          .set({
            status: "failed",
            error_code: "provider_job_missing",
            error_message: "The upstream transcription job was not found",
            completed_at: new Date(),
            updated_at: new Date(),
          })
          .where(eq(SttTranscriptions.transcription_uuid, transcriptionUuid))
          .returning();

        return GenResObj(
          Code.OK,
          true,
          "STT transcription fetched successfully",
          serializeSttTranscription(failed ?? row),
        );
      }

      const modelError =
        error instanceof SttModelError
          ? error
          : new SttModelError(
              "Failed to refresh transcription status",
              "transcription_refresh_failed",
              500,
            );

      return GenResObj(modelError.httpStatus, false, modelError.message, {
        transcription: serializeSttTranscription(row),
        error: { code: modelError.code, message: modelError.message },
      });
    }
  }

  return GenResObj(
    Code.OK,
    true,
    "STT transcription fetched successfully",
    serializeSttTranscription(row),
  );
};

export const downloadSttTranscription = async (
  transcriptionUuid: string,
  userUuid: string,
  format: "txt" | "srt" | "vtt",
) => {
  const row = await findOwnedTranscription(transcriptionUuid, userUuid);
  if (!row) {
    return { response: GenResObj(Code.NOT_FOUND, false, "STT transcription not found") };
  }

  if (row.status !== "completed") {
    // Refresh once in case the job finished since last poll.
    if (row.status === "queued" || row.status === "processing") {
      const refreshed = await getSttTranscription(transcriptionUuid, userUuid);
      if (!refreshed.data.success) return { response: refreshed };
      const latest = refreshed.data.data;
      if (latest?.status !== "completed") {
        return {
          response: GenResObj(
            Code.CONFLICT,
            false,
            "Transcript download is not ready yet",
            latest,
          ),
        };
      }
    } else {
      return {
        response: GenResObj(
          Code.CONFLICT,
          false,
          "Transcript download is only available for completed jobs",
          serializeSttTranscription(row),
        ),
      };
    }
  }

  try {
    const file = await downloadTranscriptionJob(row.provider_job_id, format);
    const safeName = (row.original_filename || "transcript").replace(/\.[^.]+$/, "");
    return {
      file: {
        ...file,
        fileName: `${safeName}.${format}`,
      },
    };
  } catch (error) {
    const modelError =
      error instanceof SttModelError
        ? error
        : new SttModelError(
            "Failed to download transcription",
            "transcription_download_failed",
            500,
          );

    return {
      response: GenResObj(modelError.httpStatus, false, modelError.message, {
        error: { code: modelError.code, message: modelError.message },
      }),
    };
  }
};

export const deleteSttTranscription = async (
  transcriptionUuid: string,
  userUuid: string,
) => {
  const row = await findOwnedTranscription(transcriptionUuid, userUuid);
  if (!row) return GenResObj(Code.NOT_FOUND, false, "STT transcription not found");

  try {
    await deleteTranscriptionJob(row.provider_job_id);
  } catch (error) {
    // Still delete locally if upstream is already gone.
    if (!(error instanceof SttModelError && error.httpStatus === 404)) {
      const modelError =
        error instanceof SttModelError
          ? error
          : new SttModelError(
              "Failed to cancel upstream transcription job",
              "transcription_delete_failed",
              500,
            );
      return GenResObj(modelError.httpStatus, false, modelError.message);
    }
  }

  await db
    .delete(SttTranscriptions)
    .where(
      and(
        eq(SttTranscriptions.transcription_uuid, transcriptionUuid),
        eq(SttTranscriptions.user_uuid, userUuid),
      ),
    );

  return GenResObj(Code.OK, true, "STT transcription deleted successfully", {
    transcriptionUuid,
  });
};
