import { NextFunction, Request, Response } from "express";
import * as AuthProvider from "./auth.provider";
import {
  otpEmailValidator,
  passwordResetOtpVerifyValidator,
  resetPasswordValidator,
  signInOtpVerifyValidator,
  signInValidator,
  signUpOtpVerifyValidator,
  signUpValidator,
  updateProfileValidator,
} from "./auth.validate";

export const AuthController = {
  signUp: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = signUpValidator.parse(req.body);
      const { code, data } = await AuthProvider.signUp(payload);
      res.status(code).json(data);
    } catch (error) {
      next(error);
    }
  },

  verifySignUpOtp: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = signUpOtpVerifyValidator.parse(req.body);
      const { code, data } = await AuthProvider.verifySignUpOtp(payload);
      res.status(code).json(data);
    } catch (error) {
      next(error);
    }
  },

  resendSignUpOtp: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = otpEmailValidator.parse(req.body);
      const { code, data } = await AuthProvider.resendSignUpOtp(payload);
      res.status(code).json(data);
    } catch (error) {
      next(error);
    }
  },

  signIn: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = signInValidator.parse(req.body);
      const { code, data } = await AuthProvider.signIn(payload);
      res.status(code).json(data);
    } catch (error) {
      next(error);
    }
  },

  verifySignInOtp: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = signInOtpVerifyValidator.parse(req.body);
      const { code, data } = await AuthProvider.verifySignInOtp(payload);
      res.status(code).json(data);
    } catch (error) {
      next(error);
    }
  },

  updateProfile: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = updateProfileValidator.parse(req.body);
      const { code, data } = await AuthProvider.updateProfile(req, payload);
      res.status(code).json(data);
    } catch (error) {
      next(error);
    }
  },

  requestPasswordResetOtp: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = otpEmailValidator.parse(req.body);
      const { code, data } = await AuthProvider.requestPasswordResetOtp(payload);
      res.status(code).json(data);
    } catch (error) {
      next(error);
    }
  },

  verifyPasswordResetOtp: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = passwordResetOtpVerifyValidator.parse(req.body);
      const { code, data } = await AuthProvider.verifyPasswordResetOtp(payload);
      res.status(code).json(data);
    } catch (error) {
      next(error);
    }
  },

  resetPassword: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = resetPasswordValidator.parse(req.body);
      const { code, data } = await AuthProvider.resetPassword(
        payload,
        req.headers.authorization,
      );
      res.status(code).json(data);
    } catch (error) {
      next(error);
    }
  },
};
