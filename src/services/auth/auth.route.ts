import { Router } from "express";
import { AuthController } from "./auth.controller";
import { authCheck } from "../../middleware/jwt.middleware";

const router = Router();

router.route("/sign-up").post(AuthController.signUp);
router.route("/sign-up/verify-otp").post(AuthController.verifySignUpOtp);
router.route("/sign-up/resend-otp").post(AuthController.resendSignUpOtp);

router.route("/sign-in").post(AuthController.signIn);
router.route("/sign-in/verify-otp").post(AuthController.verifySignInOtp);

router.get("/google", AuthController.googleStart);
router.get("/google/callback", AuthController.googleCallback);

router.get("/microsoft", AuthController.microsoftStart);
router.get("/microsoft/callback", AuthController.microsoftCallback);

router.get("/apple", AuthController.appleStart);
router.post("/apple/callback", AuthController.appleCallback);
router.get("/apple/callback", AuthController.appleCallback);

router
  .route("/update-profile")
  .post(authCheck(["superAdmin", "admin", "tenant", "user", "superAnalyst", "compliance"]), AuthController.updateProfile);

router.route("/forgot-password/resend-otp").post(AuthController.requestPasswordResetOtp);
router.route("/forgot-password/verify-otp").post(AuthController.verifyPasswordResetOtp);
router.route("/forgot-password/reset").post(AuthController.resetPassword);

export default router;
