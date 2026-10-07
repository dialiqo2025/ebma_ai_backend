import { access } from "node:fs/promises";
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { TtsGenerations } from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import { prepareTextForTts } from "../llm/llm.provider";
import {
  audioMimeTypeByFormat,
  deleteTtsAudio,
  deleteTtsReferenceAudio,
  getTtsAudioPath,
  isAllowedTtsReferenceSample,
  isTtsAutoProcessEnabled,
  isTtsModelConfigured,
  readTtsReferenceAudioBase64,
  saveTtsAudio,
  saveTtsReferenceAudio,
  serializeTtsGeneration,
  wrapPcmS16leAsWav,
} from "./tts.helper";
import {
  openTtsModelStream,
  synthesizeWithTtsModel,
  TtsModelError,
  type TtsModelStream,
} from "./tts.model";
import { TTS_EMOTION_OPTIONS, TTS_STYLE_TAG_GROUPS } from "./tts.emotion";
import { ttsCloneSampleMaxBytes } from "./tts.upload";
import { recordUsage } from "../billing/billing.provider";
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

/** Load clone reference for GPU `reference: { audio_base64, text }`. */
const resolveCloneReferenceForModel = async (generation: {
  voice_mode: string;
  reference_audio_file_name: string | null;
  reference_text: string | null;
}) => {
  if (generation.voice_mode !== "clone") return {};

  if (!generation.reference_audio_file_name) {
    throw new TtsModelError(
      "Voice clone requires a reference audio sample",
      "clone_sample_required",
      422,
    );
  }

  try {
    const audioBase64 = await readTtsReferenceAudioBase64(
      generation.reference_audio_file_name,
    );
    return {
      referenceAudioBase64: audioBase64,
      referenceText: generation.reference_text ?? "",
    };
  } catch {
    throw new TtsModelError(
      "Clone reference audio sample was not found",
      "clone_sample_missing",
      422,
    );
  }
};

const clearCloneReferenceAfterUse = async (
  generationUuid: string,
  userUuid: string,
  referenceFileName: string | null,
) => {
  if (!referenceFileName) return;
  await deleteTtsReferenceAudio(referenceFileName);
  await db
    .update(TtsGenerations)
    .set({
      reference_audio_file_name: null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(TtsGenerations.generation_uuid, generationUuid),
        eq(TtsGenerations.user_uuid, userUuid),
      ),
    );
};

export const createTtsGeneration = async (
  userUuid: string,
  payload: CreateTtsGeneration,
  voiceSample?: Express.Multer.File,
) => {
  if (payload.voiceMode === "clone") {
    if (!voiceSample?.buffer?.length) {
      return GenResObj(
        Code.BAD_REQUEST,
        false,
        "voiceSample file is required when voiceMode is clone",
      );
    }
    if (!isAllowedTtsReferenceSample(voiceSample)) {
      return GenResObj(
        Code.UNSUPPORTED_MEDIA_TYPE,
        false,
        "Voice sample must be WAV, MP3, FLAC, or OGG",
      );
    }
    if (voiceSample.size > ttsCloneSampleMaxBytes()) {
      return GenResObj(
        Code.REQUEST_TOO_LONG,
        false,
        "Voice sample exceeds the configured size limit",
      );
    }
  }

  const [generation] = await db
    .insert(TtsGenerations)
    .values({
      user_uuid: userUuid,
      input_text: payload.text,
      language: payload.language,
      voice_mode: payload.voiceMode,
      voice_id: payload.voiceMode === "clone" ? (payload.voiceId ?? null) : null,
      reference_text:
        payload.voiceMode === "clone" ? (payload.sampleTranscript ?? "") : null,
      emotion: payload.emotion ?? null,
      speed: payload.speed,
      pitch: payload.pitch,
      audio_format: payload.outputFormat,
    })
    .returning();

  if (!generation) throw new Error("TTS generation creation failed");

  let referenceFileName: string | null = null;
  try {
    if (payload.voiceMode === "clone" && voiceSample) {
      referenceFileName = await saveTtsReferenceAudio(
        generation.generation_uuid,
        voiceSample,
      );
      const [withReference] = await db
        .update(TtsGenerations)
        .set({
          reference_audio_file_name: referenceFileName,
          updated_at: new Date(),
        })
        .where(eq(TtsGenerations.generation_uuid, generation.generation_uuid))
        .returning();

      if (!withReference) throw new Error("TTS reference sample save failed");
      Object.assign(generation, withReference);
    }
  } catch (error) {
    await db
      .delete(TtsGenerations)
      .where(eq(TtsGenerations.generation_uuid, generation.generation_uuid));
    if (referenceFileName) await deleteTtsReferenceAudio(referenceFileName);
    throw error;
  }

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

  if (
    resultingVoiceMode === "clone" &&
    !existing.reference_audio_file_name
  ) {
    return GenResObj(
      Code.UNPROCESSABLE_ENTITY,
      false,
      "Clone generations need a voice sample upload; create a new clone request",
    );
  }

  if (resultingVoiceMode === "default" && existing.reference_audio_file_name) {
    await deleteTtsReferenceAudio(existing.reference_audio_file_name);
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
      ...(payload.sampleTranscript !== undefined
        ? { reference_text: payload.sampleTranscript }
        : {}),
      ...(resultingVoiceMode === "default"
        ? { reference_audio_file_name: null, reference_text: null }
        : {}),
      ...(payload.emotion !== undefined ? { emotion: payload.emotion } : {}),
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
  await deleteTtsReferenceAudio(deleted.reference_audio_file_name);

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
    const llmText =
      process.env.LLM_MODEL_ENDPOINT && process.env.LLM_API_KEY
        ? (await prepareTextForTts({
            text: claimed.input_text,
            language: claimed.language,
            style: "natural",
          })).data?.data?.text
        : claimed.input_text;

    const cloneReference = await resolveCloneReferenceForModel(claimed);

    const output = await synthesizeWithTtsModel({
      text: typeof llmText === "string" ? llmText : claimed.input_text,
      language: claimed.language,
      voiceMode: claimed.voice_mode,
      ...(claimed.voice_id ? { voiceId: claimed.voice_id } : {}),
      emotion: claimed.emotion,
      ...cloneReference,
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

    await clearCloneReferenceAfterUse(
      generationUuid,
      userUuid,
      claimed.reference_audio_file_name,
    );

    void recordUsage({
      userUuid,
      type: "tts_characters",
      quantity: claimed.input_text.length,
      idempotencyKey: `tts:${claimed.generation_uuid}`,
      ...(output.providerRequestId ? { providerReference: output.providerRequestId } : {}),
      metadata: { generationUuid: claimed.generation_uuid, language: claimed.language },
    });

    const [finalRow] = await db
      .select()
      .from(TtsGenerations)
      .where(eq(TtsGenerations.generation_uuid, generationUuid))
      .limit(1);

    return GenResObj(
      Code.OK,
      true,
      "Speech generated successfully",
      serializeTtsGeneration(finalRow ?? completed),
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

export type PreparedTtsStream =
  | { response: ReturnType<typeof GenResObj> }
  | {
      stream: TtsModelStream;
      generationUuid: string;
      userUuid: string;
      inputText: string;
      complete: (rawAudio: Buffer) => Promise<void>;
      fail: (error: unknown) => Promise<ReturnType<typeof GenResObj>>;
    };

/**
 * Claim a queued/failed generation and open a GPU streaming synthesis response.
 * Caller pipes `stream.body` to the HTTP client, then calls `complete`/`fail`.
 */
export const prepareTtsStream = async (
  generationUuid: string,
  userUuid: string,
): Promise<PreparedTtsStream> => {
  const generation = await findOwnedGeneration(generationUuid, userUuid);
  if (!generation) {
    return { response: GenResObj(Code.NOT_FOUND, false, "TTS generation not found") };
  }

  if (generation.status === "processing") {
    return {
      response: GenResObj(Code.CONFLICT, false, "TTS generation is already processing"),
    };
  }

  if (generation.status === "completed") {
    return {
      response: GenResObj(
        Code.CONFLICT,
        false,
        "TTS generation is already completed — use the audio download endpoint",
        serializeTtsGeneration(generation),
      ),
    };
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
    return {
      response: GenResObj(
        Code.CONFLICT,
        false,
        "TTS generation could not be claimed for streaming",
      ),
    };
  }

  const markFailed = async (error: unknown) => {
    const modelError =
      error instanceof TtsModelError
        ? error
        : new TtsModelError("TTS streaming failed", "generation_failed", 500);

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
      console.error("Unexpected TTS stream error:", error);
    }

    return GenResObj(
      modelError.httpStatus,
      false,
      modelError.message,
      failed ? serializeTtsGeneration(failed) : undefined,
    );
  };

  try {
    // Skip LLM polish on the stream path so first audio byte arrives ASAP.
    const cloneReference = await resolveCloneReferenceForModel(claimed);

    const stream = await openTtsModelStream({
      text: claimed.input_text,
      language: claimed.language,
      voiceMode: claimed.voice_mode,
      ...(claimed.voice_id ? { voiceId: claimed.voice_id } : {}),
      emotion: claimed.emotion,
      ...cloneReference,
      speed: claimed.speed,
      pitch: claimed.pitch,
      outputFormat: claimed.audio_format,
    });

    return {
      stream,
      generationUuid,
      userUuid,
      inputText: claimed.input_text,
      complete: async (rawAudio: Buffer) => {
        const isPcm =
          stream.contentType.includes("pcm") ||
          stream.contentType.includes("L16") ||
          stream.contentType === "application/octet-stream";

        const audioToStore = isPcm
          ? wrapPcmS16leAsWav(rawAudio, stream.sampleRate, stream.channels)
          : rawAudio;

        const savedFileName = await saveTtsAudio(
          claimed.generation_uuid,
          "wav",
          audioToStore,
        );

        await db
          .update(TtsGenerations)
          .set({
            status: "completed",
            audio_file_name: savedFileName,
            audio_mime_type: "audio/wav",
            audio_format: "wav",
            audio_size_bytes: audioToStore.length,
            provider_request_id: stream.providerRequestId ?? null,
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
          );

        await clearCloneReferenceAfterUse(
          generationUuid,
          userUuid,
          claimed.reference_audio_file_name,
        );

        void recordUsage({
          userUuid,
          type: "tts_characters",
          quantity: claimed.input_text.length,
          idempotencyKey: `tts-stream:${generationUuid}`,
          ...(stream.providerRequestId
            ? { providerReference: stream.providerRequestId }
            : {}),
          metadata: { generationUuid, stream: true },
        });
      },
      fail: markFailed,
    };
  } catch (error) {
    return { response: await markFailed(error) };
  }
};

export const getTtsOptions = () =>
  GenResObj(Code.OK, true, "TTS options fetched successfully", {
    maxTextCharacters: 1500,
    languages: "model-dependent",
    voiceModes: ["default", "clone"],
    audioFormats: ["wav", "mp3", "ogg"],
    emotions: TTS_EMOTION_OPTIONS,
    styleTags: TTS_STYLE_TAG_GROUPS,
    speed: { min: 0.5, max: 1.5, step: 0.1, default: 1 },
    pitch: { min: 0.5, max: 1.5, step: 0.1, default: 1 },
    autoProcess: isTtsAutoProcessEnabled(),
    modelConfigured: isTtsModelConfigured(),
    voiceClone: {
      enabled: isTtsModelConfigured(),
      sampleFormats: ["wav", "mp3", "flac", "ogg"],
      sampleMinDurationSeconds: 5,
      sampleMaxDurationSeconds: 15,
      sampleMaxBytes: ttsCloneSampleMaxBytes(),
      sampleTranscriptMaxCharacters: 2000,
      requiresSampleTranscript: false,
    },
    streaming: {
      enabled: isTtsModelConfigured(),
      endpoint: "POST /tts/generations/:generation_uuid/stream",
      encoding: "pcm_s16le",
      contentType: "audio/pcm",
      sampleRate: Number(process.env.TTS_STREAM_SAMPLE_RATE) || 24_000,
      channels: Number(process.env.TTS_STREAM_CHANNELS) || 1,
    },
  });
