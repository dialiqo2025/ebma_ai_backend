import { Router } from "express";
import { UserController } from "./user.controller";
import { authCheck } from "../../middleware/jwt.middleware";

const router = Router();

router.route("/summary").get(authCheck(["superAdmin"]), UserController.userSummary);
router.route("/:user_uuid").get(authCheck(["superAdmin"]), UserController.getUserById);
router.route("/").post(authCheck(["superAdmin"]), UserController.createUser);
router.route("/").get(authCheck(["superAdmin"]), UserController.listUsers);
router.route("/").put(authCheck(["superAdmin"]), UserController.updateUser);
router.route("/").delete(authCheck(["superAdmin"]), UserController.deleteUser);

export default router;
