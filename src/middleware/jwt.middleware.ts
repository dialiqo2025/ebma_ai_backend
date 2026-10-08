import jwt from "jsonwebtoken";
import { HttpStatusCodes as Code } from "../utils/httpType.util";
import { NextFunction, Request, Response } from "express";
import { db } from "../config/database/connection.database";
import { Users } from "../schema/user.schema";
import { eq } from "drizzle-orm";
import { API_KEY_PREFIX, resolveApiKey } from "../services/apikey/apikey.provider";
import type { ApiKeyScope } from "../schema/api-key.schema";

// export type AuthRequset exten

// API keys only reach service endpoints; billing, account and admin routes stay JWT-only.
const apiKeyScopeFor = (req: Request): ApiKeyScope | null => {
  const service = req.baseUrl.split("/").pop();
  if (req.path.startsWith("/admin")) return null;
  if (service === "tts" || service === "stt") return service;
  if (service === "translate") return "translate";
  if (service === "chat") return "llm";
  if (service === "llm" && req.path === "/process") return "llm";
  // Call centers read bots and call transcripts; connection credentials stay JWT-only.
  if (service === "voice-bots" && !req.path.startsWith("/connections")) return "voice";
  return null;
};

const authenticateApiKey = async (rawKey: string, role: string[], req: Request, res: Response, next: NextFunction) => {
  const scope = apiKeyScopeFor(req);
  if (!scope) {
    res.status(Code.FORBIDDEN).json({ success: false, message: "API keys cannot access this route", data: null });
    return;
  }

  const resolved = await resolveApiKey(rawKey);
  if (!resolved.ok) {
    res.status(Code.UNAUTHORIZED).json({ success: false, message: resolved.message, data: null });
    return;
  }
  if (!resolved.key.scopes.includes(scope)) {
    res.status(Code.FORBIDDEN).json({ success: false, message: `This API key does not have the ${scope} scope`, data: null });
    return;
  }

  const [user] = await db.select().from(Users).where(eq(Users.user_uuid, resolved.key.user_uuid)).limit(1);
  if (!user?.user_enabled || !user.email_verified) {
    res.status(Code.FORBIDDEN).json({ success: false, message: "Your account is not active", data: null });
    return;
  }
  if (!role.includes(user.role)) {
    res.status(Code.FORBIDDEN).json({ success: false, message: "You are not authorized to access this route", data: null });
    return;
  }

  req.user = { userId: user.user_uuid, role: user.role, apiKeyId: resolved.key.key_uuid };
  next();
};

export const authCheck = (role: string[]) => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      let jwtToken: string | undefined;
      // Check if headers has authorization
      if (
        req.headers.authorization &&
        req.headers.authorization.startsWith("Bearer")
      ) {
        jwtToken = req.headers.authorization.split(" ")[1];
      }

      // Check if JWT token exists or not
      if (!jwtToken) {
        res.status(Code.RESTRICTED).json({
          success: false,
          message: "Access token not found",
          data: null,
        });
        return;
      }

      if (jwtToken.startsWith(API_KEY_PREFIX)) {
        await authenticateApiKey(jwtToken, role, req, res, next);
        return;
      }

      const secretKey = process.env.JWT_SECRET_KEY!;

      // Verify JWT token
      jwt.verify(jwtToken, secretKey, async (err: any, decodedToken: any) => {
        if (err) {
          const currentTime = new Date();
          console.log("Getting error in auth middleware", err);
          // Handle expired token
          if (err.expiredAt && currentTime > err.expiredAt) {
            return res.status(Code.RESTRICTED).json({
              success: false,
              message: `Oops! You've been logged out. Please log in to keep going.`,
              data: null,
            });
          }

          return res.status(Code.RESTRICTED).json({
            success: false,
            message: "Token is invalid",
            data: null,
          });
        }

        // Check if user exists
        const checkAvlUser: any = await db
          .select()
          .from(Users)
          .where(eq(Users.user_uuid, decodedToken.id));

        if (checkAvlUser.length === 0) {
          return res.status(Code.BAD_REQUEST).json({
            success: false,
            message: "User not found",
            data: null,
          });
        };

        if (!checkAvlUser[0]?.user_enabled || !checkAvlUser[0]?.email_verified) {
          return res.status(Code.FORBIDDEN).json({
            success: false,
            message: "Your account is not active",
            data: null,
          });
        }

        // Check if the user's role is allowed
        if (checkAvlUser[0]?.role && !role.includes(checkAvlUser[0]?.role)) {
          return res.status(Code.RESTRICTED).json({
            success: false,
            message: "You are not authorized to access this route",
            data: null,
          });
        };

        // Attach user data to the request object and proceed
        req.user = {
          userId: checkAvlUser[0].user_uuid,
          role: checkAvlUser[0].role,
        };
        next();
      });
    } catch (error) {
      console.error("Error in Auth Middleware:", error);
      res.status(Code.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: "Internal server error",
        data: null,
      });
      return;
    }
  };
};
