import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

const AUDIO_DIRECTORY = path.resolve(
  process.env.TTS_AUDIO_DIRECTORY ?? path.join(process.cwd(), "storage", "tts"),
);

const REFERENCE_DIRECTORY = path.resolve(
  process.env.TTS_REFERENCE_DIRECTORY ??
    path.join(process.cwd(), "storage", "tts-reference"),
);

const ALLOWED_REFERENCE_EXTENSIONS = new Set([
  "wav",
  "mp3",
  "flac",
  "ogg",
  "webm",
  "m4a",
]);

export const isTtsAutoProcessEnabled = () =>
  process.env.TTS_AUTO_PROCESS?.toLowerCase() === "true";

export const isTtsModelConfigured = () => Boolean(process.env.TTS_MODEL_ENDPOINT?.trim());

export const audioMimeTypeByFormat = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
} as const;

/** Default sample rate for GPU `stream: true` PCM (override with TTS_STREAM_SAMPLE_RATE). */
export const ttsStreamSampleRate = () => {
  const value = Number(process.env.TTS_STREAM_SAMPLE_RATE);
  return Number.isInteger(value) && value > 0 ? value : 24_000;
};

export const ttsStreamChannels = () => {
  const value = Number(process.env.TTS_STREAM_CHANNELS);
  return Number.isInteger(value) && value > 0 ? value : 1;
};

/** Wrap raw PCM s16le mono/stereo into a WAV container for disk storage / replay. */
export const wrapPcmS16leAsWav = (
  pcm: Buffer,
  sampleRate: number,
  channels = 1,
): Buffer => {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length - (pcm.length % blockAlign);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm.subarray(0, dataSize)]);
};

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

const extensionFromUpload = (file: Express.Multer.File) => {
  const fromName = path.extname(file.originalname || "").slice(1).toLowerCase();
  if (ALLOWED_REFERENCE_EXTENSIONS.has(fromName)) return fromName;

  const mime = (file.mimetype || "").toLowerCase();
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("flac")) return "flac";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  return "wav";
};

export const isAllowedTtsReferenceSample = (file: Express.Multer.File) => {
  const ext = extensionFromUpload(file);
  return ALLOWED_REFERENCE_EXTENSIONS.has(ext);
};

export const saveTtsReferenceAudio = async (
  generationUuid: string,
  file: Express.Multer.File,
) => {
  await mkdir(REFERENCE_DIRECTORY, { recursive: true });

  const ext = extensionFromUpload(file);
  const fileName = `${generationUuid}.ref.${ext}`;
  const destination = path.join(REFERENCE_DIRECTORY, fileName);
  const temporary = path.join(REFERENCE_DIRECTORY, `${fileName}.tmp`);

  await writeFile(temporary, file.buffer, { flag: "w" });
  await rename(temporary, destination);
  return fileName;
};

export const getTtsReferenceAudioPath = (fileName: string) => {
  const safeFileName = path.basename(fileName);
  return path.join(REFERENCE_DIRECTORY, safeFileName);
};

export const readTtsReferenceAudioBase64 = async (fileName: string) => {
  const buffer = await readFile(getTtsReferenceAudioPath(fileName));
  return buffer.toString("base64");
};

export const deleteTtsReferenceAudio = async (fileName: string | null) => {
  if (!fileName) return;
  await rm(getTtsReferenceAudioPath(fileName), { force: true });
};

export const serializeTtsGeneration = (generation: any) => ({
  generationUuid: generation.generation_uuid,
  text: generation.input_text,
  language: generation.language,
  voiceMode: generation.voice_mode,
  voiceId: generation.voice_id,
  hasReferenceSample: Boolean(generation.reference_audio_file_name),
  referenceText: generation.reference_text ?? null,
  emotion: generation.emotion ?? null,
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
