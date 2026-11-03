import { Router } from "express";
import { authCheck } from "../../middleware/jwt.middleware";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import {
  cleanupExpiredObservabilityLogs,
  getObservabilitySettings,
  listApiTransactions,
  listGpuTransactions,
  listObservedUsers,
  monitoredArtifact,
  monitoredTranscript,
  updateObservabilitySettings,
} from "./observability.provider";

const router = Router();
const superAdmin = authCheck(["superAdmin"]);
const send = (res: any, data: unknown, message = "Monitoring data fetched successfully") => res.status(200).json(GenResObj(Code.OK, true, message, data).data);

router.get("/api-transactions", superAdmin, async (req, res, next) => {
  try { send(res, await listApiTransactions(req.query)); } catch (error) { next(error); }
});
router.get("/gpu-transactions", superAdmin, async (req, res, next) => {
  try { send(res, await listGpuTransactions(req.query)); } catch (error) { next(error); }
});
router.get("/users", superAdmin, async (req, res, next) => {
  try { send(res, await listObservedUsers(req.query)); } catch (error) { next(error); }
});
router.get("/settings", superAdmin, async (_req, res, next) => {
  try { send(res, await getObservabilitySettings()); } catch (error) { next(error); }
});
router.put("/settings", superAdmin, async (req, res, next) => {
  try {
    const value = Number(req.body?.retentionDays);
    if (!Number.isInteger(value) || value < 1 || value > 365) {
      res.status(422).json(GenResObj(Code.UNPROCESSABLE_ENTITY, false, "Retention days must be a whole number between 1 and 365").data);
      return;
    }
    send(res, await updateObservabilitySettings(value, req.user!.userId), "Log retention updated successfully");
  } catch (error) { next(error); }
});
router.post("/cleanup", superAdmin, async (_req, res, next) => {
  try { send(res, await cleanupExpiredObservabilityLogs(), "Expired monitoring logs deleted successfully"); } catch (error) { next(error); }
});
router.get("/gpu-transactions/:log_uuid/artifact", superAdmin, async (req, res, next) => {
  try {
    const artifact = await monitoredArtifact(String(req.params.log_uuid));
    if (!artifact) {
      res.status(404).json(GenResObj(Code.NOT_FOUND, false, "Stored transcription file was not found").data);
      return;
    }
    res.setHeader("Content-Type", artifact.contentType);
    res.setHeader("Content-Disposition", `inline; filename="${artifact.name.replace(/["\\]/g, "_")}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.sendFile(artifact.path, (error) => { if (error) next(error); });
  } catch (error) { next(error); }
});
router.get("/gpu-transactions/:log_uuid/transcript", superAdmin, async (req, res, next) => {
  try {
    const transcript = await monitoredTranscript(String(req.params.log_uuid));
    if (!transcript) {
      res.status(404).json(GenResObj(Code.NOT_FOUND, false, "Stored transcript was not found").data);
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${transcript.fileName}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(transcript.content);
  } catch (error) { next(error); }
});

export default router;
