import { Router } from "express";
import { authCheck } from "../../middleware/jwt.middleware";
import { BillingController } from "./billing.controller";

const router = Router();
const authenticated = authCheck(["superAdmin", "admin", "tenant", "user", "superAnalyst", "compliance"]);
router.get("/summary", authenticated, BillingController.summary);
router.get("/usage", authenticated, BillingController.usage);
export default router;
