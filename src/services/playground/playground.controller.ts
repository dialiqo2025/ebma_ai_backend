import type { NextFunction, Request, Response } from "express";
import * as PlaygroundProvider from "./playground.provider";
import { playgroundStatusQuery, playgroundTtsBody } from "./playground.validate";

export const PlaygroundController = {
  status: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = playgroundStatusQuery.parse(req.query);
      const { code, data } = await PlaygroundProvider.getPlaygroundStatus(req, query.api);
      res.status(code).json(data);
    } catch (error) {
      next(error);
    }
  },

  tts: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = playgroundTtsBody.parse(req.body);
      const { code, data } = await PlaygroundProvider.runPlaygroundTts(req, payload);
      res.status(code).json(data);
    } catch (error) {
      next(error);
    }
  },

  stt: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file as Express.Multer.File | undefined;
      const { code, data } = await PlaygroundProvider.runPlaygroundStt(
        req,
        file as Express.Multer.File,
      );
      res.status(code).json(data);
    } catch (error) {
      next(error);
    }
  },
};
