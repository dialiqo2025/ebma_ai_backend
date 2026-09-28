import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { SttSegments, SttSessions } from "../../schema";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import { GenResObj } from "../../utils/responseFormat.util";
import { prepareTextForTts } from "../llm/llm.provider";
import {
  isSttModelConfigured,
  serializeSttSegment,
  serializeSttSession,
  STT_LANGUAGES,
  toSttStartMessage,
} from "./stt.helper";
import {
  getSttModelHealth,
  requestSttBrowserToken,
  SttModelError,
} from "./stt.model";
import type {
  CreateSttSession,
  FinishSttSession,
  ListSttSessions,
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
  });
