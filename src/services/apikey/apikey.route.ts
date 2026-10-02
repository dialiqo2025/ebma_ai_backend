import { Router } from "express";
import { authCheck } from "../../middleware/jwt.middleware";
import * as ApiKeyProvider from "./apikey.provider";

const router = Router();
// Key management is session-only: apiKeyScopeFor() rejects API keys on this router.
const authenticated = authCheck(["user", "admin", "superAdmin", "tenant"]);

router.get("/", authenticated, async (req, res, next) => { try { const result = await ApiKeyProvider.listKeys(req.user?.userId as string); res.status(result.code).json(result.data); } catch (error) { next(error); } });
router.post("/", authenticated, async (req, res, next) => { try { const result = await ApiKeyProvider.createKey(req.user?.userId as string, req.body ?? {}); res.status(result.code).json(result.data); } catch (error) { next(error); } });
router.patch("/:key_uuid", authenticated, async (req, res, next) => { try { const result = await ApiKeyProvider.renameKey(req.user?.userId as string, String(req.params.key_uuid), req.body ?? {}); res.status(result.code).json(result.data); } catch (error) { next(error); } });
router.delete("/:key_uuid", authenticated, async (req, res, next) => { try { const result = await ApiKeyProvider.revokeKey(req.user?.userId as string, String(req.params.key_uuid)); res.status(result.code).json(result.data); } catch (error) { next(error); } });

export default router;
