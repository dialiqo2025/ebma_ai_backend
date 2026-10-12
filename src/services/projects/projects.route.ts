import { Router } from "express";
import { authCheck } from "../../middleware/jwt.middleware";
import { ProjectsController } from "./projects.controller";

const router = Router();
const authenticated = authCheck(["user", "admin", "superAdmin", "tenant"]);

router.get("/", authenticated, ProjectsController.list);
router.post("/", authenticated, ProjectsController.create);
router.get("/:project_uuid", authenticated, ProjectsController.get);
router.patch("/:project_uuid", authenticated, ProjectsController.update);
router.delete("/:project_uuid/permanent", authenticated, ProjectsController.permanentlyDelete);
router.delete("/:project_uuid", authenticated, ProjectsController.archive);

export default router;
