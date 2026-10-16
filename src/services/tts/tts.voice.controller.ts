import type { NextFunction, Request, Response } from "express";
import type { TResponse } from "../../utils/types.util";
import * as VoiceProvider from "./tts.voice.provider";
import {
  createTtsVoiceValidator,
  listTtsVoicesValidator,
  ttsVoiceUuidValidator,
  updateTtsVoiceValidator,
} from "./tts.voice.validate";

const userUuid = (request: Request) => request.user?.userId as string;
const send = (response: Response, result: TResponse) => response.status(result.code).json(result.data);

export const TtsVoiceController = {
  create: async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await VoiceProvider.createTtsVoice(userUuid(req), createTtsVoiceValidator.parse(req.body), req.file));
    } catch (error) { next(error); }
  },
  list: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = listTtsVoicesValidator.parse(req.query);
      send(res, await VoiceProvider.listTtsVoices(userUuid(req), query));
    } catch (error) { next(error); }
  },
  get: async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await VoiceProvider.getTtsVoice(ttsVoiceUuidValidator.parse(req.params.voice_uuid), userUuid(req)));
    } catch (error) { next(error); }
  },
  update: async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await VoiceProvider.updateTtsVoice(ttsVoiceUuidValidator.parse(req.params.voice_uuid), userUuid(req), updateTtsVoiceValidator.parse(req.body)));
    } catch (error) { next(error); }
  },
  remove: async (req: Request, res: Response, next: NextFunction) => {
    try {
      send(res, await VoiceProvider.deleteTtsVoice(ttsVoiceUuidValidator.parse(req.params.voice_uuid), userUuid(req)));
    } catch (error) { next(error); }
  },
  audio: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await VoiceProvider.getTtsVoiceAudio(ttsVoiceUuidValidator.parse(req.params.voice_uuid), userUuid(req));
      if (result.response) { send(res, result.response); return; }
      if (!result.file) throw new Error("Voice audio lookup returned no result");
      res.setHeader("Content-Type", result.file.mimeType);
      res.setHeader("Content-Disposition", `inline; filename="${pathSafeName(result.file.fileName)}"`);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.sendFile(result.file.path, (error) => { if (error) next(error); });
    } catch (error) { next(error); }
  },
};

const pathSafeName = (name: string) => name.replace(/["\\\r\n]/g, "_");
