import { access } from "node:fs/promises";
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { TtsGenerations } from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import {
  audioMimeTypeByFormat,
  deleteTtsAudio,
  getTtsAudioPath,
  isTtsAutoProcessEnabled,
  isTtsModelConfigured,
  saveTtsAudio,
  serializeTtsGeneration,
} from "./tts.helper";
import { synthesizeWithTtsModel, TtsModelError } from "./tts.model";
import type {
  CreateTtsGeneration,
  ListTtsGenerations,
  UpdateTtsGeneration,
} from "./tts.validate";

const findOwnedGeneration = async (generationUuid: string, userUuid: string) => {
  const [generation] = await db
    .select()
    .from(TtsGenerations)
    .where(
      and(
        eq(TtsGenerations.generation_uuid, generationUuid),
        eq(TtsGenerations.user_uuid, userUuid),
      ),
    )
    .limit(1);

  return generation;
};

export const createTtsGeneration = async (
  userUuid: string,
  payload: CreateTtsGeneration,
) => {
  const [generation] = await db
    .insert(TtsGenerations)
    .values({
      user_uuid: userUuid,
      input_text: payload.text,
      language: payload.language,
      voice_mode: payload.voiceMode,
      voice_id: payload.voiceId ?? null,
      speed: payload.speed,
      pitch: payload.pitch,
      audio_format: payload.outputFormat,
    })
    .returning();

  if (!generation) throw new Error("TTS generation creation failed");

  if (!isTtsAutoProcessEnabled()) {
    return GenResObj(
      Code.ACCEPTED,
      true,
      "TTS request queued. Call the generate endpoint when the model is available",
      serializeTtsGeneration(generation),
    );
  }

  const processed = await generateTtsAudio(generation.generation_uuid, userUuid);
  if (!processed.data.success) return processed;

  return GenResObj(
    Code.CREATED,
    true,
    "Speech generated successfully",
    processed.data.data,
  );
};

export const listTtsGenerations = async (
  userUuid: string,
  query: ListTtsGenerations,
) => {
  const offset = (query.page - 1) * query.page_size;
  const filters = and(
    eq(TtsGenerations.user_uuid, userUuid),
    query.status ? eq(TtsGenerations.status, query.status) : undefined,
    query.language ? eq(TtsGenerations.language, query.language) : undefined,
    query.search ? ilike(TtsGenerations.input_text, `%${query.search}%`) : undefined,
  );

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(TtsGenerations)
    .where(filters);

  const generations = await db
    .select()
    .from(TtsGenerations)
    .where(filters)
    .orderBy(desc(TtsGenerations.created_at))
    .limit(query.page_size)
    .offset(offset);

  const totalCount = Number(countRow?.count ?? 0);
  const totalPages = Math.ceil(totalCount / query.page_size);

  return GenResObj(Code.OK, true, "TTS generations fetched successfully", {
    items: generations.map(serializeTtsGeneration),
    pagination: {
      page: query.page,
      pageSize: query.page_size,
      totalCount,
      totalPages,
      hasNextPage: query.page < totalPages,
    },
  });
};

export const getTtsGeneration = async (generationUuid: string, userUuid: string) => {
  const generation = await findOwnedGeneration(generationUuid, userUuid);
  if (!generation) {
    return GenResObj(Code.NOT_FOUND, false, "TTS generation not found");
  }

  return GenResObj(
    Code.OK,
    true,
    "TTS generation fetched successfully",
    serializeTtsGeneration(generation),
  );
};

export const updateTtsGeneration = async (
  generationUuid: string,
  userUuid: string,
  payload: UpdateTtsGeneration,
) => {
  const existing = await findOwnedGeneration(generationUuid, userUuid);
  if (!existing) {
    return GenResObj(Code.NOT_FOUND, false, "TTS generation not found");
  }

  if (existing.status === "processing" || existing.status === "completed") {
    return GenResObj(
      Code.CONFLICT,
      false,
      "Only queued or failed TTS requests can be edited",
    );
  }

  const resultingVoiceMode = payload.voiceMode ?? existing.voice_mode;
  const resultingVoiceId =
    resultingVoiceMode === "default"
      ? null
      : payload.voiceId === undefined
        ? existing.voice_id
        : payload.voiceId;

  if (resultingVoiceMode === "clone" && !resultingVoiceId) {
    return GenResObj(
      Code.UNPROCESSABLE_ENTITY,
      false,
      "voiceId is required when voiceMode is clone",
    );
  }

  const [updated] = await db
    .update(TtsGenerations)
    .set({
      ...(payload.text !== undefined ? { input_text: payload.text } : {}),
      ...(payload.language !== undefined ? { language: payload.language } : {}),
      ...(payload.voiceMode !== undefined ? { voice_mode: payload.voiceMode } : {}),
      ...(payload.voiceMode !== undefined || payload.voiceId !== undefined
        ? { voice_id: resultingVoiceId }
        : {}),
      ...(payload.speed !== undefined ? { speed: payload.speed } : {}),
      ...(payload.pitch !== undefined ? { pitch: payload.pitch } : {}),
      ...(payload.outputFormat !== undefined ? { audio_format: payload.outputFormat } : {}),
      status: "queued",
      error_code: null,
      error_message: null,
      started_at: null,
      completed_at: null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(TtsGenerations.generation_uuid, generationUuid),
        eq(TtsGenerations.user_uuid, userUuid),
      ),
    )
    .returning();

  if (!updated) throw new Error("TTS generation update failed");

  return GenResObj(
    Code.OK,
    true,
    "TTS generation updated successfully",
    serializeTtsGeneration(updated),
  );
};

export const deleteTtsGeneration = async (generationUuid: string, userUuid: string) => {
  const existing = await findOwnedGeneration(generationUuid, userUuid);
  if (!existing) {
    return GenResObj(Code.NOT_FOUND, false, "TTS generation not found");
  }

  if (existing.status === "processing") {
    return GenResObj(Code.CONFLICT, false, "A processing TTS generation cannot be deleted");
  }

  const [deleted] = await db
    .delete(TtsGenerations)
    .where(
      and(
        eq(TtsGenerations.generation_uuid, generationUuid),
        eq(TtsGenerations.user_uuid, userUuid),
      ),
    )
    .returning();

  if (!deleted) throw new Error("TTS generation deletion failed");
  await deleteTtsAudio(deleted.audio_file_name);

  return GenResObj(
    Code.OK,
    true,
    "TTS generation deleted successfully",
    { generationUuid },
  );
};

export const generateTtsAudio = async (generationUuid: string, userUuid: string) => {
  const generation = await findOwnedGeneration(generationUuid, userUuid);
  if (!generation) {
    return GenResObj(Code.NOT_FOUND, false, "TTS generation not found");
  }

  if (generation.status === "processing") {
    return GenResObj(Code.CONFLICT, false, "TTS generation is already processing");
  }

  if (generation.status === "completed") {
    return GenResObj(
      Code.CONFLICT,
      false,
      "TTS generation is already completed",
      serializeTtsGeneration(generation),
    );
  }

  const [claimed] = await db
    .update(TtsGenerations)
    .set({
      status: "processing",
      started_at: new Date(),
      completed_at: null,
      error_code: null,
      error_message: null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(TtsGenerations.generation_uuid, generationUuid),
        eq(TtsGenerations.user_uuid, userUuid),
        inArray(TtsGenerations.status, ["queued", "failed"]),
      ),
    )
    .returning();

  if (!claimed) {
    return GenResObj(
      Code.CONFLICT,
      false,
      "TTS generation could not be claimed for processing",
    );
  }

  let savedFileName: string | null = null;

  try {
    const output = await synthesizeWithTtsModel({
      text: claimed.input_text,
      language: claimed.language,
      voiceMode: claimed.voice_mode,
      ...(claimed.voice_id ? { voiceId: claimed.voice_id } : {}),
      speed: claimed.speed,
      pitch: claimed.pitch,
      outputFormat: claimed.audio_format,
    });

    savedFileName = await saveTtsAudio(
      claimed.generation_uuid,
      claimed.audio_format,
      output.audio,
    );

    const [completed] = await db
      .update(TtsGenerations)
      .set({
        status: "completed",
        audio_file_name: savedFileName,
        audio_mime_type: output.mimeType,
        audio_size_bytes: output.audio.length,
        provider_request_id: output.providerRequestId ?? null,
        error_code: null,
        error_message: null,
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(TtsGenerations.generation_uuid, generationUuid),
          eq(TtsGenerations.user_uuid, userUuid),
        ),
      )
      .returning();

    if (!completed) throw new Error("TTS generation completion update failed");

    return GenResObj(
      Code.OK,
      true,
      "Speech generated successfully",
      serializeTtsGeneration(completed),
    );
  } catch (error) {
    if (savedFileName) await deleteTtsAudio(savedFileName);

    const modelError =
      error instanceof TtsModelError
        ? error
        : new TtsModelError("TTS generation failed", "generation_failed", 500);

    const [failed] = await db
      .update(TtsGenerations)
      .set({
        status: "failed",
        error_code: modelError.code,
        error_message: modelError.message,
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(TtsGenerations.generation_uuid, generationUuid),
          eq(TtsGenerations.user_uuid, userUuid),
        ),
      )
      .returning();

    if (!(error instanceof TtsModelError)) {
      console.error("Unexpected TTS generation error:", error);
    }

    return GenResObj(
      modelError.httpStatus,
      false,
      modelError.message,
      failed ? serializeTtsGeneration(failed) : undefined,
    );
  }
};

export const getTtsAudio = async (generationUuid: string, userUuid: string) => {
  const generation = await findOwnedGeneration(generationUuid, userUuid);
  if (!generation) {
    return { response: GenResObj(Code.NOT_FOUND, false, "TTS generation not found") };
  }

  if (generation.status !== "completed" || !generation.audio_file_name) {
    return {
      response: GenResObj(Code.CONFLICT, false, "Audio is not available for this generation"),
    };
  }

  const filePath = getTtsAudioPath(generation.audio_file_name);
  try {
    await access(filePath);
  } catch {
    return {
      response: GenResObj(Code.NOT_FOUND, false, "Generated audio file was not found"),
    };
  }

  return {
    file: {
      path: filePath,
      mimeType:
        generation.audio_mime_type ?? audioMimeTypeByFormat[generation.audio_format],
      fileName: generation.audio_file_name,
    },
  };
};

export const getTtsOptions = () =>
  GenResObj(Code.OK, true, "TTS options fetched successfully", {
    maxTextCharacters: 1500,
    languages: "model-dependent",
    voiceModes: ["default", "clone"],
    audioFormats: ["wav", "mp3", "ogg"],
    speed: { min: 0.5, max: 1.5, step: 0.1, default: 1 },
    pitch: { min: 0.5, max: 1.5, step: 0.1, default: 1 },
    autoProcess: isTtsAutoProcessEnabled(),
    modelConfigured: isTtsModelConfigured(),
  });
