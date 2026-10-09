import { and, eq, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { PlaygroundTrials } from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import {
  createTranscriptionJob,
  deleteTranscriptionJob,
  getTranscriptionJob,
  SttModelError,
} from "../stt/stt.model";
import { mapProviderTranscriptionStatus } from "../stt/stt.helper";
import { isSttModelConfigured } from "../stt/stt.helper";
import { synthesizeWithTtsModel, TtsModelError } from "../tts/tts.model";
import { isTtsModelConfigured } from "../tts/tts.helper";
import { clientIpFromRequest, hashClientIp } from "./playground.ip";
import {
  acquirePlaygroundSlot,
  releasePlaygroundSlot,
} from "./playground.guard";
import {
  playgroundPortalLoginUrl,
  playgroundSttMaxBytes,
  playgroundSttPollIntervalMs,
  playgroundSttPollTimeoutMs,
  playgroundTrialLimit,
  type PlaygroundApi,
} from "./playground.limits";
import type { Request } from "express";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const trialMeta = (remaining: number, limit: number) => ({
  remaining,
  limit,
  loginUrl: playgroundPortalLoginUrl(),
});

const exhaustedResponse = (limit: number) =>
  GenResObj(Code.FORBIDDEN, false, "Free playground trials used up. Sign in to continue.", {
    code: "trial_exhausted",
    ...trialMeta(0, limit),
  });

const getUseCount = async (ipHash: string, api: PlaygroundApi) => {
  const [row] = await db
    .select({ use_count: PlaygroundTrials.use_count })
    .from(PlaygroundTrials)
    .where(and(eq(PlaygroundTrials.ip_hash, ipHash), eq(PlaygroundTrials.api, api)))
    .limit(1);
  return row?.use_count ?? 0;
};

/** Increment only when under the limit. Returns new remaining or null if exhausted. */
const consumeTrial = async (ipHash: string, api: PlaygroundApi, limit: number) => {
  const [updated] = await db
    .update(PlaygroundTrials)
    .set({
      use_count: sql`${PlaygroundTrials.use_count} + 1`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(PlaygroundTrials.ip_hash, ipHash),
        eq(PlaygroundTrials.api, api),
        sql`${PlaygroundTrials.use_count} < ${limit}`,
      ),
    )
    .returning({ use_count: PlaygroundTrials.use_count });

  if (updated) {
    return { remaining: Math.max(0, limit - updated.use_count) };
  }

  try {
    const [inserted] = await db
      .insert(PlaygroundTrials)
      .values({ ip_hash: ipHash, api, use_count: 1 })
      .returning({ use_count: PlaygroundTrials.use_count });
    return { remaining: Math.max(0, limit - (inserted?.use_count ?? 1)) };
  } catch {
    const count = await getUseCount(ipHash, api);
    if (count >= limit) return null;

    const [retried] = await db
      .update(PlaygroundTrials)
      .set({
        use_count: sql`${PlaygroundTrials.use_count} + 1`,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(PlaygroundTrials.ip_hash, ipHash),
          eq(PlaygroundTrials.api, api),
          sql`${PlaygroundTrials.use_count} < ${limit}`,
        ),
      )
      .returning({ use_count: PlaygroundTrials.use_count });

    if (!retried) return null;
    return { remaining: Math.max(0, limit - retried.use_count) };
  }
};

export const getPlaygroundStatus = async (req: Request, api: PlaygroundApi) => {
  const ipHash = hashClientIp(clientIpFromRequest(req));
  const limit = playgroundTrialLimit();
  const used = await getUseCount(ipHash, api);
  const remaining = Math.max(0, limit - used);

  return GenResObj(Code.OK, true, "Playground trial status", {
    api,
    used,
    ...trialMeta(remaining, limit),
    exhausted: remaining <= 0,
  });
};

export const runPlaygroundTts = async (
  req: Request,
  input: { text: string; language: string },
) => {
  if (!isTtsModelConfigured()) {
    return GenResObj(
      Code.SERVICE_UNAVAILABLE,
      false,
      "TTS playground is temporarily unavailable",
      { code: "model_not_configured" },
    );
  }

  const ip = clientIpFromRequest(req);
  const ipHash = hashClientIp(ip);
  const limit = playgroundTrialLimit();
  const used = await getUseCount(ipHash, "tts");
  if (used >= limit) return exhaustedResponse(limit);

  const slot = acquirePlaygroundSlot(ip, "tts");
  if (!slot.ok) {
    return GenResObj(
      Code.TOO_MANY_REQUESTS,
      false,
      slot.reason === "busy"
        ? "A playground request is already in progress"
        : "Playground is at capacity. Please try again shortly",
      { code: slot.reason === "busy" ? "in_flight" : "capacity" },
    );
  }

  try {
    const output = await synthesizeWithTtsModel({
      text: input.text,
      language: input.language,
      voiceMode: "default",
      speed: 1,
      pitch: 1,
      outputFormat: "wav",
    });

    const consumed = await consumeTrial(ipHash, "tts", limit);
    if (!consumed) return exhaustedResponse(limit);

    return GenResObj(Code.OK, true, "TTS playground audio generated", {
      api: "tts",
      mimeType: output.mimeType,
      audioBase64: output.audio.toString("base64"),
      ...trialMeta(consumed.remaining, limit),
    });
  } catch (error) {
    if (error instanceof TtsModelError) {
      return GenResObj(error.httpStatus, false, error.message, {
        code: error.code,
      });
    }
    console.error("Playground TTS error:", error);
    return GenResObj(Code.INTERNAL_SERVER_ERROR, false, "TTS playground failed", {
      code: "playground_tts_failed",
    });
  } finally {
    releasePlaygroundSlot(ip, "tts");
  }
};

const pollTranscriptionText = async (jobId: string) => {
  const deadline = Date.now() + playgroundSttPollTimeoutMs();
  const interval = playgroundSttPollIntervalMs();

  while (Date.now() < deadline) {
    const job = await getTranscriptionJob(jobId);
    const status = mapProviderTranscriptionStatus(job.status);

    if (status === "completed") {
      const result =
        job.result && typeof job.result === "object"
          ? (job.result as Record<string, unknown>)
          : null;
      const text =
        typeof result?.text === "string"
          ? result.text
          : typeof job.text === "string"
            ? job.text
            : "";
      return { ok: true as const, text: text.trim(), job };
    }

    if (status === "failed" || status === "cancelled") {
      const err =
        job.error && typeof job.error === "object"
          ? (job.error as { message?: string; code?: string })
          : null;
      return {
        ok: false as const,
        message: err?.message || "Transcription failed",
        code: err?.code || "transcription_failed",
      };
    }

    await sleep(interval);
  }

  return {
    ok: false as const,
    message: "Transcription timed out",
    code: "transcription_timeout",
  };
};

export const runPlaygroundStt = async (req: Request, file: Express.Multer.File) => {
  if (!isSttModelConfigured()) {
    return GenResObj(
      Code.SERVICE_UNAVAILABLE,
      false,
      "STT playground is temporarily unavailable",
      { code: "model_not_configured" },
    );
  }

  if (!file?.buffer?.length) {
    return GenResObj(Code.BAD_REQUEST, false, "Audio file is required", {
      code: "file_required",
    });
  }

  if (file.size > playgroundSttMaxBytes()) {
    return GenResObj(Code.REQUEST_TOO_LONG, false, "Audio exceeds the playground size limit", {
      code: "file_too_large",
      maxBytes: playgroundSttMaxBytes(),
    });
  }

  const ip = clientIpFromRequest(req);
  const ipHash = hashClientIp(ip);
  const limit = playgroundTrialLimit();
  const used = await getUseCount(ipHash, "stt");
  if (used >= limit) return exhaustedResponse(limit);

  const slot = acquirePlaygroundSlot(ip, "stt");
  if (!slot.ok) {
    return GenResObj(
      Code.TOO_MANY_REQUESTS,
      false,
      slot.reason === "busy"
        ? "A playground request is already in progress"
        : "Playground is at capacity. Please try again shortly",
      { code: slot.reason === "busy" ? "in_flight" : "capacity" },
    );
  }

  let jobId: string | null = null;
  try {
    const created = await createTranscriptionJob({
      file: file.buffer,
      filename: file.originalname || "playground.webm",
      contentType: file.mimetype,
      language: "en",
      diarize: false,
    });
    jobId = created.job_id;

    const polled = await pollTranscriptionText(jobId);
    if (!polled.ok) {
      return GenResObj(Code.UNPROCESSABLE_ENTITY, false, polled.message, {
        code: polled.code,
      });
    }

    const consumed = await consumeTrial(ipHash, "stt", limit);
    if (!consumed) return exhaustedResponse(limit);

    return GenResObj(Code.OK, true, "STT playground transcription ready", {
      api: "stt",
      transcript: polled.text,
      ...trialMeta(consumed.remaining, limit),
    });
  } catch (error) {
    if (error instanceof SttModelError) {
      return GenResObj(error.httpStatus, false, error.message, {
        code: error.code,
      });
    }
    console.error("Playground STT error:", error);
    return GenResObj(Code.INTERNAL_SERVER_ERROR, false, "STT playground failed", {
      code: "playground_stt_failed",
    });
  } finally {
    if (jobId) {
      void deleteTranscriptionJob(jobId).catch(() => undefined);
    }
    releasePlaygroundSlot(ip, "stt");
  }
};
