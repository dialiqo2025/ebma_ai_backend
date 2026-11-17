import { Router } from "express";
import { authCheck } from "../../middleware/jwt.middleware";
import { VoiceController } from "./voice.controller";

const router = Router();
// Portal users only (JWT). API keys are rejected by authCheck for this service.
const authenticated = authCheck(["user", "admin", "superAdmin", "tenant"]);

router.get("/options", authenticated, VoiceController.options);
router.post("/sessions", authenticated, VoiceController.createSession);
router.post("/sessions/:room_name/end", authenticated, VoiceController.endSession);
// Called by the LiveKit voice agent; authenticated by HMAC signature, not JWT.
router.post("/agent-events", VoiceController.agentEvent);

export default router;
