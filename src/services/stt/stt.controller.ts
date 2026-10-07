import type { NextFunction, Request, Response } from "express";
import type { TResponse } from "../../utils/types.util";
import * as SttProvider from "./stt.provider";
import {
  createSttSessionValidator,
  createSttTranscriptionValidator,
  finishSttSessionValidator,
  listSttSessionsValidator,
  listSttTranscriptionsValidator,
  sttFinalSegmentValidator,
  sttSessionUuidValidator,
  sttTokenRequestValidator,
  sttTranscriptionDownloadValidator,
  sttTranscriptionUuidValidator,
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
        await SttProvider.deleteSttSession(
          sessionUuid,
          userUuidFromRequest(req),
          req.query.force === "true" || req.query.force === "1",
        ),
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

  createTranscription: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = createSttTranscriptionValidator.parse({
        language: req.body?.language ?? req.query?.language,
        diarize: req.body?.diarize ?? req.query?.diarize,
        speakers: req.body?.speakers ?? req.query?.speakers,
      });
      sendProviderResponse(
        res,
        await SttProvider.createSttTranscription(
          userUuidFromRequest(req),
          payload,
          req.file as Express.Multer.File,
        ),
      );
    } catch (error) {
      next(error);
    }
  },

  listTranscriptions: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = listSttTranscriptionsValidator.parse(req.query);
      sendProviderResponse(
        res,
        await SttProvider.listSttTranscriptions(userUuidFromRequest(req), query),
      );
    } catch (error) {
      next(error);
    }
  },

  getTranscription: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transcriptionUuid = sttTranscriptionUuidValidator.parse(
        req.params.transcription_uuid,
      );
      sendProviderResponse(
        res,
        await SttProvider.getSttTranscription(
          transcriptionUuid,
          userUuidFromRequest(req),
        ),
      );
    } catch (error) {
      next(error);
    }
  },

  downloadTranscription: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transcriptionUuid = sttTranscriptionUuidValidator.parse(
        req.params.transcription_uuid,
      );
      const { format } = sttTranscriptionDownloadValidator.parse(req.query);
      const result = await SttProvider.downloadSttTranscription(
        transcriptionUuid,
        userUuidFromRequest(req),
        format,
      );

      if (result.response) {
        sendProviderResponse(res, result.response);
        return;
      }

      if (!result.file) throw new Error("Transcription download returned no file");

      res.setHeader("Content-Type", result.file.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${result.file.fileName}"`,
      );
      res.send(result.file.content);
    } catch (error) {
      next(error);
    }
  },

  removeTranscription: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transcriptionUuid = sttTranscriptionUuidValidator.parse(
        req.params.transcription_uuid,
      );
      sendProviderResponse(
        res,
        await SttProvider.deleteSttTranscription(
          transcriptionUuid,
          userUuidFromRequest(req),
        ),
      );
    } catch (error) {
      next(error);
    }
  },
};
