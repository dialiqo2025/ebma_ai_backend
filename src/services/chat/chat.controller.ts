import type { NextFunction, Request, Response } from "express";
import type { TResponse } from "../../utils/types.util";
import * as ChatProvider from "./chat.provider";
import { chatMessageValidator, chatSpeechValidator } from "./chat.validate";

const sendProviderResponse = (response: Response, result: TResponse) => {
  response.status(result.code).json(result.data);
};

export const ChatController = {
  options: (_req: Request, res: Response) => {
    sendProviderResponse(res, ChatProvider.getChatOptions());
  },

  message: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = chatMessageValidator.parse(req.body);
      sendProviderResponse(res, await ChatProvider.replyToChatMessage(req.user?.userId as string, payload));
    } catch (error) {
      next(error);
    }
  },

  speech: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = chatSpeechValidator.parse(req.body);
      const result = await ChatProvider.synthesizeChatSpeech(payload);

      if (result.response) {
        sendProviderResponse(res, result.response);
        return;
      }

      res.setHeader("Content-Type", result.audio.mimeType);
      res.setHeader("Content-Length", String(result.audio.audio.length));
      res.setHeader("Cache-Control", "no-store");
      res.end(result.audio.audio);
    } catch (error) {
      next(error);
    }
  },
};
