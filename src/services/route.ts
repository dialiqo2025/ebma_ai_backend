import { Router } from "express";

// Auth & core
import Auth from "./auth/auth.route";
import User from "./user/user.route";
import Tts from "./tts/tts.route";
import Stt from "./stt/stt.route";
import Llm from "./llm/llm.route";
import Chat from "./chat/chat.route";
import Billing from "./billing/billing.route";
import ApiKey from "./apikey/apikey.route";
import Translate from "./translate/translate.route";
import Playground from "./playground/playground.route";

const router = Router();

// 1. Auth & Core
router.use("/auth", Auth);
router.use("/user", User);
router.use("/tts", Tts);
router.use("/stt", Stt);
router.use("/llm", Llm);
router.use("/chat", Chat);
router.use("/billing", Billing);
router.use("/api-keys", ApiKey);
router.use("/translate", Translate);
// Public website playground (IP-limited; GPU stays behind this API)
router.use("/playground", Playground);

export default router;
