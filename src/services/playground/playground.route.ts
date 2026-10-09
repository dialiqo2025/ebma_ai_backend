import { Router } from "express";
import { PlaygroundController } from "./playground.controller";
import {
  playgroundOriginGuard,
  playgroundRateLimitGuard,
} from "./playground.guard";
import { playgroundSttUpload } from "./playground.upload";

const router = Router();

router.use(playgroundOriginGuard);

router.get("/status", PlaygroundController.status);

router.post("/tts", playgroundRateLimitGuard, PlaygroundController.tts);

router.post(
  "/stt",
  playgroundRateLimitGuard,
  (req, res, next) => {
    playgroundSttUpload(req, res, (uploadError) => {
      if (uploadError) {
        const tooLarge =
          typeof uploadError === "object" &&
          uploadError !== null &&
          "code" in uploadError &&
          (uploadError as { code?: string }).code === "LIMIT_FILE_SIZE";
        res.status(tooLarge ? 413 : 400).json({
          success: false,
          message: tooLarge
            ? "Audio exceeds the playground size limit"
            : uploadError instanceof Error
              ? uploadError.message
              : "File upload failed",
          data: { code: tooLarge ? "file_too_large" : "upload_failed" },
        });
        return;
      }
      next();
    });
  },
  PlaygroundController.stt,
);

export default router;
