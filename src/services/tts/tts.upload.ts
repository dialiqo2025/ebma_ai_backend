import multer from "multer";

const DEFAULT_SAMPLE_MAX_BYTES = 10 * 1024 * 1024;

const sampleMaxBytes = () => {
  const value = Number(process.env.TTS_CLONE_SAMPLE_MAX_BYTES);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_SAMPLE_MAX_BYTES;
};

/** Multipart field `voiceSample` for clone-mode TTS create. */
export const ttsVoiceSampleUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: sampleMaxBytes(),
    files: 1,
  },
}).single("voiceSample");

export const ttsCloneSampleMaxBytes = sampleMaxBytes;
