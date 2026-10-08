import { Router } from "express";
import { authCheck } from "../../middleware/jwt.middleware";
import { VoiceBotController } from "./voice-bot.controller";

const router = Router();
// API keys with the "voice" scope reach the bot and call routes; /connections is session-only.
const authenticated = authCheck(["user", "admin", "superAdmin", "tenant"]);

router.get("/connections", authenticated, VoiceBotController.listConnections);
router.post("/connections", authenticated, VoiceBotController.createConnection);
router.patch("/connections/:connection_uuid", authenticated, VoiceBotController.updateConnection);
router.delete("/connections/:connection_uuid", authenticated, VoiceBotController.revokeConnection);

router.get("/calls", authenticated, VoiceBotController.listCalls);
router.get("/calls/:id", authenticated, VoiceBotController.getCall);

router.get("/", authenticated, VoiceBotController.listBots);
router.post("/", authenticated, VoiceBotController.createBot);
router.get("/:bot_uuid", authenticated, VoiceBotController.getBot);
router.patch("/:bot_uuid", authenticated, VoiceBotController.updateBot);
router.delete("/:bot_uuid", authenticated, VoiceBotController.deleteBot);

export default router;
