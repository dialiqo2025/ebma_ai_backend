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

const redirectOAuthResult = (
  res: Response,
  result: { ok: true; redirectUrl: string } | { ok: false; message: string },
) => {
  if (!result.ok) {
    return res.redirect(AuthProvider.oauthFailRedirect(result.message));
  }
  return res.redirect(result.redirectUrl);
};

const redirectOAuthStart = (res: Response, getUrl: () => string) => {
  try {
    return res.redirect(getUrl());
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "OAuth is not configured. Check server environment variables.";
    return res.redirect(AuthProvider.oauthFailRedirect(message));
  }
};

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

  googleStart: async (_req: Request, res: Response) => {
    return redirectOAuthStart(res, () => AuthProvider.getGoogleAuthUrl());
  },

  googleCallback: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const oauthError = typeof req.query.error === "string" ? req.query.error : undefined;
      if (oauthError) {
        return res.redirect(AuthProvider.oauthFailRedirect(oauthError));
      }
      const result = await AuthProvider.handleGoogleCallback(code);
      return redirectOAuthResult(res, result);
    } catch (error) {
      next(error);
    }
  },

  microsoftStart: async (_req: Request, res: Response) => {
    return redirectOAuthStart(res, () => AuthProvider.getMicrosoftAuthUrl());
  },

  microsoftCallback: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const oauthError = typeof req.query.error === "string" ? req.query.error : undefined;
      if (oauthError) {
        return res.redirect(AuthProvider.oauthFailRedirect(oauthError));
      }
      const result = await AuthProvider.handleMicrosoftCallback(code);
      return redirectOAuthResult(res, result);
    } catch (error) {
      next(error);
    }
  },

  appleStart: async (_req: Request, res: Response) => {
    return redirectOAuthStart(res, () => AuthProvider.getAppleAuthUrl());
  },

  appleCallback: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Record<string, unknown>;
      const oauthError =
        typeof body.error === "string"
          ? body.error
          : typeof req.query.error === "string"
            ? req.query.error
            : undefined;
      if (oauthError) {
        return res.redirect(AuthProvider.oauthFailRedirect(oauthError));
      }

      const code =
        typeof body.code === "string"
          ? body.code
          : typeof req.query.code === "string"
            ? req.query.code
            : undefined;
      const idToken =
        typeof body.id_token === "string"
          ? body.id_token
          : typeof req.query.id_token === "string"
            ? req.query.id_token
            : undefined;
      const userJson = typeof body.user === "string" ? body.user : undefined;

      const result = await AuthProvider.handleAppleCallback({
        ...(code ? { code } : {}),
        ...(idToken ? { idToken } : {}),
        ...(userJson ? { userJson } : {}),
      });
      return redirectOAuthResult(res, result);
    } catch (error) {
      next(error);
    }
  },
};
