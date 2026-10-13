import { Router } from "express";
import { ContactController } from "./contact.controller";
import { contactOriginGuard, contactRateLimitGuard } from "./contact.guard";

const router = Router();

router.post("/inquiries", contactOriginGuard, contactRateLimitGuard, ContactController.submit);

export default router;
