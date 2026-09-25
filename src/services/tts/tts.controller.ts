import type { NextFunction, Request, Response } from "express";
import type { TResponse } from "../../utils/types.util";
import * as TtsProvider from "./tts.provider";
import {
  createTtsGenerationValidator,
  listTtsGenerationsValidator,
  ttsGenerationUuidValidator,
  updateTtsGenerationValidator,
} from "./tts.validate";

const userUuidFromRequest = (request: Request) => request.user?.userId as string;

const sendProviderResponse = (response: Response, result: TResponse) => {
  response.status(result.code).json(result.data);
};

export const TtsController = {
  options: (_req: Request, res: Response) => {
    sendProviderResponse(res, TtsProvider.getTtsOptions());
  },

  create: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = createTtsGenerationValidator.parse(req.body);
      const result = await TtsProvider.createTtsGeneration(
        userUuidFromRequest(req),
        payload,
      );
      sendProviderResponse(res, result);
    } catch (error) {
      next(error);
    }
  },

  list: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = listTtsGenerationsValidator.parse(req.query);
      const result = await TtsProvider.listTtsGenerations(
        userUuidFromRequest(req),
        query,
      );
      sendProviderResponse(res, result);
    } catch (error) {
      next(error);
    }
  },

  get: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const generationUuid = ttsGenerationUuidValidator.parse(
        req.params.generation_uuid,
      );
      const result = await TtsProvider.getTtsGeneration(
        generationUuid,
        userUuidFromRequest(req),
      );
      sendProviderResponse(res, result);
    } catch (error) {
      next(error);
    }
  },

  update: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const generationUuid = ttsGenerationUuidValidator.parse(
        req.params.generation_uuid,
      );
      const payload = updateTtsGenerationValidator.parse(req.body);
      const result = await TtsProvider.updateTtsGeneration(
        generationUuid,
        userUuidFromRequest(req),
        payload,
      );
      sendProviderResponse(res, result);
    } catch (error) {
      next(error);
    }
  },

  remove: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const generationUuid = ttsGenerationUuidValidator.parse(
        req.params.generation_uuid,
      );
      const result = await TtsProvider.deleteTtsGeneration(
        generationUuid,
        userUuidFromRequest(req),
      );
      sendProviderResponse(res, result);
    } catch (error) {
      next(error);
    }
  },

  generate: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const generationUuid = ttsGenerationUuidValidator.parse(
        req.params.generation_uuid,
      );
      const result = await TtsProvider.generateTtsAudio(
        generationUuid,
        userUuidFromRequest(req),
      );
      sendProviderResponse(res, result);
    } catch (error) {
      next(error);
    }
  },

  audio: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const generationUuid = ttsGenerationUuidValidator.parse(
        req.params.generation_uuid,
      );
      const result = await TtsProvider.getTtsAudio(
        generationUuid,
        userUuidFromRequest(req),
      );

      if (result.response) {
        sendProviderResponse(res, result.response);
        return;
      }

      if (!result.file) throw new Error("TTS audio lookup returned no result");

      res.setHeader("Content-Type", result.file.mimeType);
      res.setHeader("Content-Disposition", `inline; filename="${result.file.fileName}"`);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.sendFile(result.file.path, (error) => {
        if (error) next(error);
      });
    } catch (error) {
      next(error);
    }
  },
};
