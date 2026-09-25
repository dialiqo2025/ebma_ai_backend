import type { NextFunction, Request, Response } from "express";
import type { TResponse } from "../../utils/types.util";
import * as SttProvider from "./stt.provider";
import {
  createSttSessionValidator,
  finishSttSessionValidator,
  listSttSessionsValidator,
  sttFinalSegmentValidator,
  sttSessionUuidValidator,
  sttTokenRequestValidator,
  updateSttSessionValidator,
} from "./stt.validate";

const userUuidFromRequest = (request: Request) => request.user?.userId as string;

const sendProviderResponse = (response: Response, result: TResponse) => {
  response.status(result.code).json(result.data);
};

export const SttController = {
  options: (_req: Request, res: Response) => {
    sendProviderResponse(res, SttProvider.getSttOptions());
  },

  health: async (_req: Request, res: Response, next: NextFunction) => {
    try {
      sendProviderResponse(res, await SttProvider.getSttHealth());
    } catch (error) {
      next(error);
    }
  },

  create: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = createSttSessionValidator.parse(req.body);
      sendProviderResponse(
        res,
        await SttProvider.createSttSession(userUuidFromRequest(req), payload),
      );
    } catch (error) {
      next(error);
    }
  },

  list: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = listSttSessionsValidator.parse(req.query);
      sendProviderResponse(
        res,
        await SttProvider.listSttSessions(userUuidFromRequest(req), query),
      );
    } catch (error) {
      next(error);
    }
  },

  get: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionUuid = sttSessionUuidValidator.parse(req.params.session_uuid);
      sendProviderResponse(
        res,
        await SttProvider.getSttSession(sessionUuid, userUuidFromRequest(req)),
      );
    } catch (error) {
      next(error);
    }
  },

  update: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionUuid = sttSessionUuidValidator.parse(req.params.session_uuid);
      const payload = updateSttSessionValidator.parse(req.body);
      sendProviderResponse(
        res,
        await SttProvider.updateSttSession(
          sessionUuid,
          userUuidFromRequest(req),
          payload,
        ),
      );
    } catch (error) {
      next(error);
    }
  },

  remove: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionUuid = sttSessionUuidValidator.parse(req.params.session_uuid);
      sendProviderResponse(
        res,
        await SttProvider.deleteSttSession(sessionUuid, userUuidFromRequest(req)),
      );
    } catch (error) {
      next(error);
    }
  },

  token: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionUuid = sttSessionUuidValidator.parse(req.params.session_uuid);
      const payload = sttTokenRequestValidator.parse(req.body);
      sendProviderResponse(
        res,
        await SttProvider.createSttBrowserToken(
          sessionUuid,
          userUuidFromRequest(req),
          payload,
        ),
      );
    } catch (error) {
      next(error);
    }
  },

  start: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionUuid = sttSessionUuidValidator.parse(req.params.session_uuid);
      sendProviderResponse(
        res,
        await SttProvider.markSttSessionStarted(sessionUuid, userUuidFromRequest(req)),
      );
    } catch (error) {
      next(error);
    }
  },

  segment: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionUuid = sttSessionUuidValidator.parse(req.params.session_uuid);
      const payload = sttFinalSegmentValidator.parse(req.body);
      sendProviderResponse(
        res,
        await SttProvider.addSttFinalSegment(
          sessionUuid,
          userUuidFromRequest(req),
          payload,
        ),
      );
    } catch (error) {
      next(error);
    }
  },

  finish: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionUuid = sttSessionUuidValidator.parse(req.params.session_uuid);
      const payload = finishSttSessionValidator.parse(req.body);
      sendProviderResponse(
        res,
        await SttProvider.finishSttSession(
          sessionUuid,
          userUuidFromRequest(req),
          payload,
        ),
      );
    } catch (error) {
      next(error);
    }
  },
};
