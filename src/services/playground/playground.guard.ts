import type { NextFunction, Request, Response } from "express";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import { clientIpFromRequest } from "./playground.ip";
import {
  playgroundAllowedOrigins,
  playgroundGlobalConcurrency,
  playgroundMinIntervalMs,
  playgroundRateLimit,
  playgroundRateWindowSeconds,
  type PlaygroundApi,
} from "./playground.limits";

type RateEntry = { count: number; resetsAt: number; lastAt: number };

const rateByIp = new Map<string, RateEntry>();
const inFlightByKey = new Map<string, number>();
let globalInFlight = 0;

const pruneRates = (now: number) => {
  if (rateByIp.size < 2_000) return;
  for (const [key, entry] of rateByIp) {
    if (entry.resetsAt <= now) rateByIp.delete(key);
  }
};

export const playgroundOriginGuard = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const originHeader = req.headers.origin;
  const allowed = playgroundAllowedOrigins();

  // Non-browser clients (curl/scripts) have no Origin — reject in production.
  if (!originHeader) {
    if (process.env.NODE_ENV === "production") {
      res.status(Code.FORBIDDEN).json({
        success: false,
        message: "Playground access is restricted to the EBMA website",
        data: { code: "origin_required" },
      });
      return;
    }
    next();
    return;
  }

  const origin = originHeader.replace(/\/$/, "");
  if (!allowed.has(origin)) {
    res.status(Code.FORBIDDEN).json({
      success: false,
      message: "Playground access is restricted to the EBMA website",
      data: { code: "origin_denied" },
    });
    return;
  }

  next();
};

export const playgroundRateLimitGuard = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const ip = clientIpFromRequest(req);
  const now = Date.now();
  const limit = playgroundRateLimit();
  const windowMs = playgroundRateWindowSeconds() * 1_000;
  const minInterval = playgroundMinIntervalMs();
  pruneRates(now);

  const existing = rateByIp.get(ip);
  if (!existing || existing.resetsAt <= now) {
    rateByIp.set(ip, { count: 1, resetsAt: now + windowMs, lastAt: now });
    next();
    return;
  }

  if (now - existing.lastAt < minInterval) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((minInterval - (now - existing.lastAt)) / 1_000),
    );
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(Code.TOO_MANY_REQUESTS).json({
      success: false,
      message: "Please wait a moment before trying again",
      data: { code: "rate_limited", retryAfterSeconds },
    });
    return;
  }

  if (existing.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetsAt - now) / 1_000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(Code.TOO_MANY_REQUESTS).json({
      success: false,
      message: "Too many playground requests. Please try again shortly",
      data: { code: "rate_limited", retryAfterSeconds },
    });
    return;
  }

  existing.count += 1;
  existing.lastAt = now;
  next();
};

export const acquirePlaygroundSlot = (
  ip: string,
  api: PlaygroundApi,
): { ok: true } | { ok: false; reason: "busy" | "capacity" } => {
  if (globalInFlight >= playgroundGlobalConcurrency()) {
    return { ok: false, reason: "capacity" };
  }
  const key = `${ip}:${api}`;
  if ((inFlightByKey.get(key) ?? 0) >= 1) {
    return { ok: false, reason: "busy" };
  }
  inFlightByKey.set(key, 1);
  globalInFlight += 1;
  return { ok: true };
};

export const releasePlaygroundSlot = (ip: string, api: PlaygroundApi) => {
  const key = `${ip}:${api}`;
  const current = inFlightByKey.get(key) ?? 0;
  if (current <= 1) inFlightByKey.delete(key);
  else inFlightByKey.set(key, current - 1);
  globalInFlight = Math.max(0, globalInFlight - 1);
};
