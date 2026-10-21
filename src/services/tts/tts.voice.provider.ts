import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { TtsVoices } from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import {
  deleteTtsVoiceAudio,
  getTtsVoiceAudioPath,
  isAllowedTtsReferenceSample,
  saveTtsVoiceAudio,
  serializeTtsVoice,
} from "./tts.helper";
import { ttsCloneSampleMaxBytes } from "./tts.upload";
import type { CreateTtsVoice, UpdateTtsVoice } from "./tts.voice.validate";

const findOwnedVoice = async (voiceUuid: string, userUuid: string) => {
  const [voice] = await db
    .select()
    .from(TtsVoices)
    .where(and(eq(TtsVoices.voice_uuid, voiceUuid), eq(TtsVoices.user_uuid, userUuid)))
    .limit(1);
  return voice;
};

export const createTtsVoice = async (
  userUuid: string,
  payload: CreateTtsVoice,
  voiceSample?: Express.Multer.File,
) => {
  if (!voiceSample?.buffer?.length) {
    return GenResObj(Code.BAD_REQUEST, false, "A voice sample is required");
  }
  if (!isAllowedTtsReferenceSample(voiceSample)) {
    return GenResObj(Code.UNSUPPORTED_MEDIA_TYPE, false, "Voice sample must be WAV, MP3, FLAC, OGG, WebM, or M4A");
  }
  if (voiceSample.size > ttsCloneSampleMaxBytes()) {
    return GenResObj(Code.REQUEST_TOO_LONG, false, "Voice sample exceeds the configured size limit");
  }

  const voiceUuid = randomUUID();
  let fileName: string | null = null;
  try {
    fileName = await saveTtsVoiceAudio(voiceUuid, voiceSample);
    const [voice] = await db
      .insert(TtsVoices)
      .values({
        voice_uuid: voiceUuid,
        user_uuid: userUuid,
        name: payload.name,
        language: payload.language,
        description: payload.description ?? null,
        reference_audio_file_name: fileName,
        original_file_name: path.basename(voiceSample.originalname || "voice-sample"),
        audio_mime_type: voiceSample.mimetype || "application/octet-stream",
        audio_size_bytes: voiceSample.size,
        reference_text: payload.referenceText ?? null,
        consent_confirmed_at: new Date(),
      })
      .returning();
    if (!voice) throw new Error("Voice library creation failed");
    return GenResObj(Code.CREATED, true, "Voice added to your library", serializeTtsVoice(voice));
  } catch (error) {
    if (fileName) await deleteTtsVoiceAudio(fileName);
    throw error;
  }
};

export const listTtsVoices = async (
  userUuid: string,
  query: { search?: string | undefined; page: number; page_size: number },
) => {
  const { search, page, page_size: pageSize } = query;
  const condition = search
    ? and(
        eq(TtsVoices.user_uuid, userUuid),
        or(ilike(TtsVoices.name, `%${search}%`), ilike(TtsVoices.language, `%${search}%`)),
      )
    : eq(TtsVoices.user_uuid, userUuid);
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(TtsVoices)
    .where(condition);
  const voices = await db
    .select()
    .from(TtsVoices)
    .where(condition)
    .orderBy(desc(TtsVoices.created_at))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const totalCount = Number(countRow?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  return GenResObj(Code.OK, true, "Voice library fetched", {
    items: voices.map(serializeTtsVoice),
    pagination: {
      page,
      pageSize,
      totalCount,
      totalPages,
      hasNextPage: page < totalPages,
    },
  });
};

export const getTtsVoice = async (voiceUuid: string, userUuid: string) => {
  const voice = await findOwnedVoice(voiceUuid, userUuid);
  return voice
    ? GenResObj(Code.OK, true, "Voice fetched", serializeTtsVoice(voice))
    : GenResObj(Code.NOT_FOUND, false, "Voice not found");
};

export const updateTtsVoice = async (
  voiceUuid: string,
  userUuid: string,
  payload: UpdateTtsVoice,
  voiceSample?: Express.Multer.File,
) => {
  const existing = await findOwnedVoice(voiceUuid, userUuid);
  if (!existing) return GenResObj(Code.NOT_FOUND, false, "Voice not found");

  if (voiceSample && payload.consentAccepted !== true) {
    return GenResObj(Code.BAD_REQUEST, false, "Voice consent is required to replace the reference audio");
  }
  if (voiceSample && !isAllowedTtsReferenceSample(voiceSample)) {
    return GenResObj(Code.UNSUPPORTED_MEDIA_TYPE, false, "Voice sample must be WAV, MP3, FLAC, OGG, WebM, or M4A");
  }
  if (voiceSample && voiceSample.size > ttsCloneSampleMaxBytes()) {
    return GenResObj(Code.REQUEST_TOO_LONG, false, "Voice sample exceeds the configured size limit");
  }

  let replacementFileName: string | null = null;
  try {
    if (voiceSample) {
      replacementFileName = await saveTtsVoiceAudio(`${voiceUuid}-${randomUUID()}`, voiceSample);
    }
    const [voice] = await db
      .update(TtsVoices)
      .set({
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.language !== undefined ? { language: payload.language } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.referenceText !== undefined ? { reference_text: payload.referenceText } : {}),
        ...(voiceSample && replacementFileName ? {
          reference_audio_file_name: replacementFileName,
          original_file_name: path.basename(voiceSample.originalname || "voice-sample"),
          audio_mime_type: voiceSample.mimetype || "application/octet-stream",
          audio_size_bytes: voiceSample.size,
          consent_confirmed_at: new Date(),
        } : {}),
        updated_at: new Date(),
      })
      .where(and(eq(TtsVoices.voice_uuid, voiceUuid), eq(TtsVoices.user_uuid, userUuid)))
      .returning();
    if (!voice) {
      if (replacementFileName) await deleteTtsVoiceAudio(replacementFileName);
      return GenResObj(Code.NOT_FOUND, false, "Voice not found");
    }
    if (replacementFileName) await deleteTtsVoiceAudio(existing.reference_audio_file_name);
    return GenResObj(Code.OK, true, "Voice updated", serializeTtsVoice(voice));
  } catch (error) {
    if (replacementFileName) await deleteTtsVoiceAudio(replacementFileName);
    throw error;
  }
};

export const deleteTtsVoice = async (voiceUuid: string, userUuid: string) => {
  const [voice] = await db
    .delete(TtsVoices)
    .where(and(eq(TtsVoices.voice_uuid, voiceUuid), eq(TtsVoices.user_uuid, userUuid)))
    .returning();
  if (!voice) return GenResObj(Code.NOT_FOUND, false, "Voice not found");
  await deleteTtsVoiceAudio(voice.reference_audio_file_name);
  return GenResObj(Code.OK, true, "Voice deleted");
};

export const getTtsVoiceAudio = async (voiceUuid: string, userUuid: string) => {
  const voice = await findOwnedVoice(voiceUuid, userUuid);
  if (!voice) return { response: GenResObj(Code.NOT_FOUND, false, "Voice not found") };
  return {
    file: {
      path: getTtsVoiceAudioPath(voice.reference_audio_file_name),
      fileName: voice.original_file_name || voice.reference_audio_file_name,
      mimeType: voice.audio_mime_type || "application/octet-stream",
    },
  };
};
