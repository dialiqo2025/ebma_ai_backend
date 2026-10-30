import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { authCheck } from "../../middleware/jwt.middleware";
import { SttController } from "./stt.controller";
import { sttTokenRateLimit } from "./stt.rate-limit";
import { sttTranscriptionUpload } from "./stt.upload";

const router = Router();
const authenticated = authCheck(["user", "admin", "superAdmin", "tenant"]);

// Starting an Arabic stream (JSON body, no file) mints a browser token.
const arabicStreamTokenRateLimit = (req: Request, res: Response, next: NextFunction) => {
  if (req.body?.language === "ar") {
    sttTokenRateLimit(req, res, next);
    return;
  }
  next();
};

router.get("/options", authenticated, SttController.options);
router.get("/health", authenticated, SttController.health);

router.post(
  "/transcriptions",
  authenticated,
  arabicStreamTokenRateLimit,
  sttTranscriptionUpload,
  SttController.createTranscription,
);
router.get("/transcriptions", authenticated, SttController.listTranscriptions);
router.get(
  "/transcriptions/:transcription_uuid",
  authenticated,
  SttController.getTranscription,
);
router.patch(
  "/transcriptions/:transcription_uuid",
  authenticated,
  SttController.finishArabicTranscription,
);
router.get(
  "/transcriptions/:transcription_uuid/download",
  authenticated,
  SttController.downloadTranscription,
);
router.delete(
  "/transcriptions/:transcription_uuid",
  authenticated,
  SttController.removeTranscription,
);

router.post("/sessions", authenticated, SttController.create);
router.get("/sessions", authenticated, SttController.list);
router.get("/sessions/:session_uuid", authenticated, SttController.get);
router.patch("/sessions/:session_uuid", authenticated, SttController.update);
router.delete("/sessions/:session_uuid", authenticated, SttController.remove);
router.post(
  "/sessions/:session_uuid/token",
  authenticated,
  sttTokenRateLimit,
  SttController.token,
);
router.post("/sessions/:session_uuid/start", authenticated, SttController.start);
router.post("/sessions/:session_uuid/segments", authenticated, SttController.segment);
router.post("/sessions/:session_uuid/finish", authenticated, SttController.finish);

export default router;
