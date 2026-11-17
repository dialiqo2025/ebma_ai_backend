import type { NextFunction, Request, Response } from "express";
import type { TResponse } from "../../utils/types.util";
import * as VoiceProvider from "./voice.provider";
import { createVoiceSessionValidator, voiceRoomNameValidator } from "./voice.validate";

const send = (res: Response, result: TResponse) => {
  res.status(result.code).json(result.data);
};

export const VoiceController = {
  options: async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await VoiceProvider.getVoiceOptions(req.user?.userId as string));
    } catch (error) {
      next(error);
    }
  },

  createSession: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = createVoiceSessionValidator.parse(req.body ?? {});
      send(res, await VoiceProvider.createVoiceSession(req.user?.userId as string, payload));
    } catch (error) {
      next(error);
    }
  },

  endSession: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const roomName = voiceRoomNameValidator.parse(req.params.room_name);
      send(res, await VoiceProvider.endVoiceSession(req.user?.userId as string, roomName));
    } catch (error) {
      next(error);
    }
  },

  /** Signed webhook from the voice agent (raw body; see index.ts). */
  agentEvent: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
      send(
        res,
        await VoiceProvider.handleAgentEvent(
          raw,
          req.header("x-ebma-timestamp") ?? undefined,
          req.header("x-ebma-signature") ?? undefined,
        ),
      );
    } catch (error) {
      next(error);
    }
  },
};
