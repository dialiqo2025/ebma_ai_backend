import type { NextFunction, Request, Response } from "express";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";

type RateLimitEntry = {
  count: number;
  resetsAt: number;
};

const tokenRequests = new Map<string, RateLimitEntry>();

const positiveIntegerFromEnvironment = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const pruneExpiredEntries = (now: number) => {
  if (tokenRequests.size < 1_000) return;
  for (const [userUuid, entry] of tokenRequests) {
    if (entry.resetsAt <= now) tokenRequests.delete(userUuid);
  }
};

export const sttTokenRateLimit = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const userUuid = req.user?.userId as string;
  const now = Date.now();
  const limit = positiveIntegerFromEnvironment("STT_TOKEN_RATE_LIMIT", 5);
  const windowSeconds = positiveIntegerFromEnvironment("STT_TOKEN_RATE_WINDOW_SECONDS", 60);
  const existing = tokenRequests.get(userUuid);

  pruneExpiredEntries(now);

  if (!existing || existing.resetsAt <= now) {
    tokenRequests.set(userUuid, { count: 1, resetsAt: now + windowSeconds * 1_000 });
    next();
    return;
  }

  if (existing.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetsAt - now) / 1_000));
    res.setHeader("Retry-After", retryAfterSeconds.toString());
    res.status(Code.TOO_MANY_REQUESTS).json({
      success: false,
      message: "Too many STT token requests. Please try again shortly",
      data: { retryAfterSeconds },
    });
    return;
  }

  existing.count += 1;
  next();
};
