import path from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";

const AUDIO_DIRECTORY = path.resolve(
  process.env.TTS_AUDIO_DIRECTORY ?? path.join(process.cwd(), "storage", "tts"),
);

export const isTtsAutoProcessEnabled = () =>
  process.env.TTS_AUTO_PROCESS?.toLowerCase() === "true";

export const isTtsModelConfigured = () => Boolean(process.env.TTS_MODEL_ENDPOINT?.trim());

export const audioMimeTypeByFormat = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
} as const;

export const saveTtsAudio = async (
  generationUuid: string,
  format: keyof typeof audioMimeTypeByFormat,
  audio: Buffer,
) => {
  await mkdir(AUDIO_DIRECTORY, { recursive: true });

  const fileName = `${generationUuid}.${format}`;
  const destination = path.join(AUDIO_DIRECTORY, fileName);
  const temporary = path.join(AUDIO_DIRECTORY, `${fileName}.tmp`);

  await writeFile(temporary, audio, { flag: "w" });
  await rename(temporary, destination);

  return fileName;
};

export const getTtsAudioPath = (fileName: string) => {
  const safeFileName = path.basename(fileName);
  return path.join(AUDIO_DIRECTORY, safeFileName);
};

export const deleteTtsAudio = async (fileName: string | null) => {
  if (!fileName) return;
  await rm(getTtsAudioPath(fileName), { force: true });
};

export const serializeTtsGeneration = (generation: any) => ({
  generationUuid: generation.generation_uuid,
  text: generation.input_text,
  language: generation.language,
  voiceMode: generation.voice_mode,
  voiceId: generation.voice_id,
  speed: generation.speed,
  pitch: generation.pitch,
  outputFormat: generation.audio_format,
  status: generation.status,
  audioUrl:
    generation.status === "completed" && generation.audio_file_name
      ? `/api/v1/tts/generations/${generation.generation_uuid}/audio`
      : null,
  audioMimeType: generation.audio_mime_type,
  audioSizeBytes: generation.audio_size_bytes,
  providerRequestId: generation.provider_request_id,
  error:
    generation.error_code || generation.error_message
      ? {
          code: generation.error_code,
          message: generation.error_message,
        }
      : null,
  startedAt: generation.started_at,
  completedAt: generation.completed_at,
  createdAt: generation.created_at,
  updatedAt: generation.updated_at,
});
