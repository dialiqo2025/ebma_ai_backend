import { Router } from "express";
import { authCheck } from "../../middleware/jwt.middleware";
import { TtsController } from "./tts.controller";
import { ttsVoiceSampleUpload } from "./tts.upload";
import { TtsVoiceController } from "./tts.voice.controller";

const router = Router();
const authenticated = authCheck(["user", "admin", "superAdmin", "tenant"]);

router.post("/voices", authenticated, (req, res, next) => {
  ttsVoiceSampleUpload(req, res, (uploadError) => {
    if (uploadError) {
      res.status(413).json({ success: false, message: "Voice sample exceeds the upload size limit", data: null });
      return;
    }
    next();
  });
}, TtsVoiceController.create);
router.get("/voices", authenticated, TtsVoiceController.list);
router.get("/voices/:voice_uuid", authenticated, TtsVoiceController.get);
router.patch("/voices/:voice_uuid", authenticated, (req, res, next) => {
  ttsVoiceSampleUpload(req, res, (uploadError) => {
    if (uploadError) {
      res.status(413).json({ success: false, message: "Voice sample exceeds the upload size limit", data: null });
      return;
    }
    next();
  });
}, TtsVoiceController.update);
router.delete("/voices/:voice_uuid", authenticated, TtsVoiceController.remove);
router.get("/voices/:voice_uuid/audio", authenticated, TtsVoiceController.audio);

router.get("/options", authenticated, TtsController.options);
router.get("/health", authenticated, TtsController.health);
router.post(
  "/generations",
  authenticated,
  (req, res, next) => {
    ttsVoiceSampleUpload(req, res, (uploadError) => {
      if (uploadError) {
        res.status(413).json({
          success: false,
          message: "Voice sample exceeds the upload size limit",
          data: null,
        });
        return;
      }
      next();
    });
  },
  TtsController.create,
);
router.get("/generations", authenticated, TtsController.list);
router.get("/generations/:generation_uuid", authenticated, TtsController.get);
router.patch("/generations/:generation_uuid", authenticated, TtsController.update);
router.delete("/generations/:generation_uuid", authenticated, TtsController.remove);
router.post(
  "/generations/:generation_uuid/generate",
  authenticated,
  TtsController.generate,
);
router.post(
  "/generations/:generation_uuid/stream",
  authenticated,
  TtsController.stream,
);
router.get("/generations/:generation_uuid/audio", authenticated, TtsController.audio);

export default router;
