import type { NextFunction, Request, Response } from "express";
import type { TResponse } from "../../utils/types.util";
import * as VoiceBotProvider from "./voice-bot.provider";
import {
  createConnectionValidator,
  createVoiceBotValidator,
  listCallsValidator,
  updateConnectionValidator,
  updateVoiceBotValidator,
} from "./voice-bot.validate";

const send = (res: Response, result: TResponse) => {
  res.status(result.code).json(result.data);
};

const userId = (req: Request) => req.user?.userId as string;
const param = (req: Request, name: string) => String(req.params[name]);

const handle = (fn: (req: Request) => Promise<TResponse>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await fn(req));
    } catch (error) {
      next(error);
    }
  };

export const VoiceBotController = {
  listBots: handle((req) => VoiceBotProvider.listBots(userId(req))),
  getBot: handle((req) => VoiceBotProvider.getBot(userId(req), param(req, "bot_uuid"))),
  createBot: handle((req) => VoiceBotProvider.createBot(userId(req), createVoiceBotValidator.parse(req.body))),
  updateBot: handle((req) => VoiceBotProvider.updateBot(userId(req), param(req, "bot_uuid"), updateVoiceBotValidator.parse(req.body))),
  deleteBot: handle((req) => VoiceBotProvider.deleteBot(userId(req), param(req, "bot_uuid"))),

  listConnections: handle((req) => VoiceBotProvider.listConnections(userId(req))),
  createConnection: handle((req) => VoiceBotProvider.createConnection(userId(req), createConnectionValidator.parse(req.body))),
  updateConnection: handle((req) => VoiceBotProvider.updateConnection(userId(req), param(req, "connection_uuid"), updateConnectionValidator.parse(req.body))),
  revokeConnection: handle((req) => VoiceBotProvider.revokeConnection(userId(req), param(req, "connection_uuid"))),

  listCalls: handle((req) => VoiceBotProvider.listCalls(userId(req), listCallsValidator.parse(req.query))),
  getCall: handle((req) => VoiceBotProvider.getCall(userId(req), param(req, "id"))),
};
