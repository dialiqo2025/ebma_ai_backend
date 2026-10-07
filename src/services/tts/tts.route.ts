import { Router } from "express";
import { authCheck } from "../../middleware/jwt.middleware";
import { TtsController } from "./tts.controller";
import { ttsVoiceSampleUpload } from "./tts.upload";

const router = Router();
const authenticated = authCheck(["user", "admin", "superAdmin", "tenant"]);

router.get("/options", authenticated, TtsController.options);
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
