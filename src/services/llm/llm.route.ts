import { Router } from "express";
import { authCheck } from "../../middleware/jwt.middleware";
import { processTranscriptWithLlm } from "./llm.provider";
import * as AdminLlm from "./llm.admin.provider";
import * as UserLlm from "./llm.user.provider";

const router = Router();
const authenticated = authCheck(["user", "admin", "superAdmin", "tenant"]);

router.post("/process", authenticated, async (req, res, next) => {
  try {
    const { text, language = "hi", style = "natural", systemPrompt } = req.body ?? {};

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: "A non-empty text value is required",
        data: null,
      });
    }

    const result = await processTranscriptWithLlm({
      text,
      language,
      style,
      systemPrompt,
      userUuid: req.user?.userId as string,
    });

    return res.status(result.code).json(result.data);
  } catch (error) {
    next(error);
  }
});
router.get("/config", authenticated, async (req, res, next) => { try { const result = await UserLlm.getUserConfig(req.user?.userId as string); res.status(result.code).json(result.data); } catch (error) { next(error); } });
router.put("/config", authenticated, async (req, res, next) => { try { const result = await UserLlm.saveUserConfig(req.user?.userId as string, req.body); res.status(result.code).json(result.data); } catch (error) { next(error); } });

const superAdmin = authCheck(["superAdmin"]);
router.get("/admin/models", superAdmin, async (_req, res, next) => { try { const result = await AdminLlm.listModels(); res.status(result.code).json(result.data); } catch (error) { next(error); } });
router.post("/admin/models", superAdmin, async (req, res, next) => { try { const result = await AdminLlm.createModel(req.body); res.status(result.code).json(result.data); } catch (error) { next(error); } });
router.patch("/admin/models/:model_uuid", superAdmin, async (req, res, next) => { try { const result = await AdminLlm.updateModel(String(req.params.model_uuid), req.body); res.status(result.code).json(result.data); } catch (error) { next(error); } });
router.delete("/admin/models/:model_uuid", superAdmin, async (req, res, next) => { try { const result = await AdminLlm.deleteModel(String(req.params.model_uuid)); res.status(result.code).json(result.data); } catch (error) { next(error); } });

export default router;
