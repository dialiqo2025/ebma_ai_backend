import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

type RequestContext = { requestId: string; request: Request };
const storage = new AsyncLocalStorage<RequestContext>();

export const observabilityRequestContext = (
  request: Request,
  _response: Response,
  next: NextFunction,
) => {
  storage.run({ requestId: randomUUID(), request }, next);
};

export const currentRequestContext = () => storage.getStore();
