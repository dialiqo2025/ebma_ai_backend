import { Router } from "express";

// Auth & core
import Auth from "./auth/auth.route";
import User from "./user/user.route";
import Tts from "./tts/tts.route";

const router = Router();

// 1. Auth & Core
router.use("/auth", Auth);
router.use("/user", User);
router.use("/tts", Tts);

export default router;
