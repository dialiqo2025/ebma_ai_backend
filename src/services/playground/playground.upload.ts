import multer from "multer";
import { playgroundSttMaxBytes } from "./playground.limits";

export const playgroundSttUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: playgroundSttMaxBytes(),
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype.startsWith("audio/") ||
      file.mimetype === "video/webm" ||
      file.mimetype === "application/octet-stream";
    if (!ok) {
      cb(new Error("Only audio uploads are allowed"));
      return;
    }
    cb(null, true);
  },
}).single("file");
