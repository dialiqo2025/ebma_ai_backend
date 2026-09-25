import { NextFunction, Request, Response } from "express";
import * as UserProvider from "./user.provider";
import {
  createUserType,
  createUserValidator,
  updateUserType,
  updateUserValidator,
  userUuidValidator,
} from "./user.validate";
import { TResponse } from "../../utils/types.util";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";

export const UserController = {
  createUser: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = {
        ...req.body,
      } as createUserType;

      createUserValidator.parse(payload);

      const { code, data }: TResponse = await UserProvider.createUser(payload);

      res.status(code).json(data);
      return;
    } catch (error) {
      next(error);
    }
  },

  listUsers: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, Number(req.query.page ?? 1));
      const page_size = Math.max(1, Number(req.query.page_size ?? 10));
      const exclude_user_uuid = req.user?.userId ?? (req.user as any)?.user?.userId;
      const search =
        typeof req.query.search === "string" && req.query.search.trim().length > 0
          ? req.query.search.trim()
          : undefined;
      const role = typeof req.query.role === "string" ? req.query.role : undefined;
      const includeTenants =
        req.query.includeTenants === "true"
          ? true
          : req.query.includeTenants === "false"
          ? false
          : undefined;
      const isActive =
        req.query.isActive === "true"
          ? true
          : req.query.isActive === "false"
          ? false
          : undefined;

      const { code, data }: TResponse = await UserProvider.listUsers(
        page,
        page_size,
        exclude_user_uuid,
        search,
        role,
        isActive,
        includeTenants
      );

      res.status(code).json(data);
      return;
    } catch (error) {
      next(error);
    }
  },

  userSummary: async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { code, data }: TResponse = await UserProvider.userSummary();

      res.status(code).json(data);
      return;
    } catch (error) {
      next(error);
    }
  },

  getUserById: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user_uuid = userUuidValidator.parse(req.params.user_uuid);

      const { code, data }: TResponse = await UserProvider.getUserById(user_uuid);

      res.status(code).json(data);
      return;
    } catch (error) {
      next(error);
    }
  },

  updateUser: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user_uuid = userUuidValidator.parse(req.body.user_uuid);

      const payload = {
        ...req.body,
      } as updateUserType;

      updateUserValidator.parse(payload);

      if (Object.keys(payload).length === 0) {
        const { code, data } = GenResObj(Code.BAD_REQUEST, false, "No fields to update");
        res.status(code).json(data);
        return;
      }

      const { code, data }: TResponse = await UserProvider.updateUser(user_uuid, payload);

      res.status(code).json(data);
      return;
    } catch (error) {
      next(error);
    }
  },

  deleteUser: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user_uuid = userUuidValidator.parse(req.query.user_uuid);

      console.log("Getting the new schema log :", user_uuid)

      const { code, data }: TResponse = await UserProvider.deleteUser(user_uuid);

      res.status(code).json(data);
      return;
    } catch (error) {
      next(error);
    }
  },
};
