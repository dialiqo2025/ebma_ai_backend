import multer from "multer";
import { maxUploadBytes } from "./stt.helper";

export const sttTranscriptionUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxUploadBytes(),
    files: 1,
  },
}).single("file");
