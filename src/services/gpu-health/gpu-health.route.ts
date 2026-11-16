import { Router } from "express";
import { z } from "zod";
import { authCheck } from "../../middleware/jwt.middleware";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import { GenResObj } from "../../utils/responseFormat.util";
import {
  addGpuHealthRecipient,
  cleanupGpuHealthChecks,
  getGpuHealthConfiguration,
  listGpuHealthChecks,
  removeGpuHealthRecipient,
  runGpuHealthCheck,
  updateGpuHealthSettings,
} from "./gpu-health.provider";

const router = Router();
const superAdmin = authCheck(["superAdmin"]);
const send = (res: any, data: unknown, message: string, code = Code.OK) =>
  res.status(code).json(GenResObj(code, true, message, data).data);

const settingsValidator = z.object({
  enabled: z.boolean(),
  checkIntervalMinutes: z.coerce.number().int().min(1).max(10_080),
  retentionDays: z.coerce.number().int().min(1).max(3650),
  notificationsEnabled: z.boolean(),
  notifyHealthy: z.boolean().default(false),
  notifyHighUsage: z.boolean().default(true),
  notifyUnhealthy: z.boolean().default(true),
  notifyRecovered: z.boolean().default(false),
  highUsageThresholdPercent: z.coerce.number().int().min(1).max(100).default(80),
  repeatAlertMinutes: z.coerce.number().int().min(1).max(10_080).default(60),
}).strict();
const recipientValidator = z.object({ email: z.email().max(320) }).strict();
const uuidValidator = z.uuid();

router.get("/configuration", superAdmin, async (_req, res, next) => {
  try { send(res, await getGpuHealthConfiguration(), "GPU health configuration fetched successfully"); }
  catch (error) { next(error); }
});

router.put("/settings", superAdmin, async (req, res, next) => {
  try {
    const payload = settingsValidator.parse(req.body);
    send(res, await updateGpuHealthSettings(payload, req.user!.userId), "GPU health settings updated successfully");
  } catch (error) { next(error); }
});

router.post("/recipients", superAdmin, async (req, res, next) => {
  try {
    const { email } = recipientValidator.parse(req.body);
    send(res, await addGpuHealthRecipient(email, req.user!.userId), "Notification recipient added successfully", Code.CREATED);
  } catch (error) { next(error); }
});

router.delete("/recipients/:recipient_uuid", superAdmin, async (req, res, next) => {
  try {
    const recipientUuid = uuidValidator.parse(req.params.recipient_uuid);
    const removed = await removeGpuHealthRecipient(recipientUuid);
    if (!removed) {
      res.status(Code.NOT_FOUND).json(GenResObj(Code.NOT_FOUND, false, "Notification recipient was not found").data);
      return;
    }
    send(res, removed, "Notification recipient removed successfully");
  } catch (error) { next(error); }
});

router.get("/checks", superAdmin, async (req, res, next) => {
  try { send(res, await listGpuHealthChecks(req.query), "GPU health checks fetched successfully"); }
  catch (error) { next(error); }
});

router.post("/check-now", superAdmin, async (_req, res, next) => {
  try { send(res, await runGpuHealthCheck("manual"), "GPU health check completed successfully"); }
  catch (error) { next(error); }
});

router.post("/cleanup", superAdmin, async (_req, res, next) => {
  try { send(res, await cleanupGpuHealthChecks(), "Expired GPU health checks deleted successfully"); }
  catch (error) { next(error); }
});

export default router;
