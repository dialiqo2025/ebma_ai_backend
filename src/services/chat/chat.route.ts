import { Router } from "express";
import { authCheck } from "../../middleware/jwt.middleware";
import { ChatController } from "./chat.controller";

const router = Router();
const authenticated = authCheck(["user", "admin", "superAdmin", "tenant"]);

router.get("/options", authenticated, ChatController.options);
router.post("/messages", authenticated, ChatController.message);
router.post("/speech", authenticated, ChatController.speech);

export default router;
