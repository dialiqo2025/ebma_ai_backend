import jwt from "jsonwebtoken";
import { HttpStatusCodes as Code } from "../utils/httpType.util";
import { NextFunction, Request, Response } from "express";
import { db } from "../config/database/connection.database";
import { Users } from "../schema/user.schema";
import { eq } from "drizzle-orm";

// export type AuthRequset exten

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
