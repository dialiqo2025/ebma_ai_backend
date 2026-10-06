import { Router } from "express";
import multer from "multer";
import { authCheck } from "../../middleware/jwt.middleware";
import * as Translate from "./translate.provider";
import { documentTranslationValidator, translateTextValidator } from "./translate.validate";

const router = Router();
const authenticated = authCheck(["user", "admin", "superAdmin", "tenant"]);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }).single("file");

router.get("/options", authenticated, (_req, res) => { const result = Translate.getTranslateOptions(); res.status(result.code).json(result.data); });
router.post("/text", authenticated, async (req, res, next) => {
  try { const result = await Translate.translateText(req.user?.userId as string, translateTextValidator.parse(req.body)); res.status(result.code).json(result.data); }
  catch (error) { next(error); }
});
router.post("/documents", authenticated, (req, res, next) => {
  upload(req, res, async (uploadError) => {
    if (uploadError) { res.status(413).json({ success: false, message: "Document exceeds the 100 MB upload limit", data: null }); return; }
    try {
      const input = documentTranslationValidator.parse({
        source_language_code: req.body.source_language_code,
        target_language_codes: typeof req.body.target_language_codes === "string" ? JSON.parse(req.body.target_language_codes) : req.body.target_language_codes,
        job_name: req.body.job_name || undefined,
        genre: req.body.genre || undefined,
        use_native_numerals: req.body.use_native_numerals === "true" ? true : req.body.use_native_numerals === "false" ? false : undefined,
        style_guidelines: req.body.style_guidelines || undefined,
      });
      const result = await Translate.createDocumentTranslation(req.user?.userId as string, req.file, input);
      res.status(result.code).json(result.data);
    } catch (error) { next(error); }
  });
});
router.get("/documents/:job_token/status", authenticated, async (req, res, next) => {
  try { const result = await Translate.getDocumentStatus(req.user?.userId as string, String(req.params.job_token)); res.status(result.code).json(result.data); }
  catch (error) { next(error); }
});
router.get("/documents/:job_token/export/:language/download", authenticated, async (req, res) => {
  const file = await Translate.getDocumentExportFile(req.user?.userId as string, String(req.params.job_token), String(req.params.language));
  if (!file) { res.status(404).json({ success: false, message: "Translated document not found", data: null }); return; }
  res.download(file.path, file.filename);
});
router.post("/documents/:job_token/export/:language", authenticated, async (req, res, next) => {
  try { const result = await Translate.triggerDocumentExport(req.user?.userId as string, String(req.params.job_token), String(req.params.language)); res.status(result.code).json(result.data); }
  catch (error) { next(error); }
});
router.get("/documents/:job_token/export/:language", authenticated, async (req, res, next) => {
  try { const result = await Translate.getDocumentExportStatus(req.user?.userId as string, String(req.params.job_token), String(req.params.language)); res.status(result.code).json(result.data); }
  catch (error) { next(error); }
});

export default router;
