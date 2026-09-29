import { Router } from "express";
import { authCheck } from "../../middleware/jwt.middleware";
import { processTranscriptWithLlm } from "./llm.provider";

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
    });

    return res.status(result.code).json(result.data);
  } catch (error) {
    next(error);
  }
});

export default router;
