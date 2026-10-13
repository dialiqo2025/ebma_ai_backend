import type { NextFunction, Request, Response } from "express";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import { clientIpFromRequest } from "../playground/playground.ip";

type RateEntry = { count: number; resetsAt: number; lastAt: number };

const rateByIp = new Map<string, RateEntry>();

const positiveInteger = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const allowedOrigins = () =>
  new Set(
    [
      process.env.SITE_URL,
      process.env.NEXT_PUBLIC_SITE_URL,
      "https://ebma.ai",
      "https://www.ebma.ai",
      "https://ebma-ai-website.onrender.com",
      "http://localhost:3001",
      "http://127.0.0.1:3001",
    ]
      .filter(Boolean)
      .map((value) => String(value).trim().replace(/\/$/, "")),
  );

export const contactOriginGuard = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const originHeader = req.headers.origin;
  if (!originHeader) {
    if (process.env.NODE_ENV === "production") {
      res.status(Code.FORBIDDEN).json({
        success: false,
        message: "Contact submissions must come from the ebma AI website",
        data: { code: "origin_required" },
      });
      return;
    }
    next();
    return;
  }

  if (!allowedOrigins().has(originHeader.replace(/\/$/, ""))) {
    res.status(Code.FORBIDDEN).json({
      success: false,
      message: "Contact submissions must come from the ebma AI website",
      data: { code: "origin_denied" },
    });
    return;
  }
  next();
};

export const contactRateLimitGuard = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const ip = clientIpFromRequest(req);
  const now = Date.now();
  const limit = positiveInteger("CONTACT_RATE_LIMIT", 5);
  const windowMs = positiveInteger("CONTACT_RATE_WINDOW_SECONDS", 3_600) * 1_000;
  const minIntervalMs = positiveInteger("CONTACT_MIN_INTERVAL_SECONDS", 15) * 1_000;

  if (rateByIp.size >= 2_000) {
    for (const [key, entry] of rateByIp) {
      if (entry.resetsAt <= now) rateByIp.delete(key);
    }
  }

  const existing = rateByIp.get(ip);
  if (!existing || existing.resetsAt <= now) {
    rateByIp.set(ip, { count: 1, resetsAt: now + windowMs, lastAt: now });
    next();
    return;
  }

  if (now - existing.lastAt < minIntervalMs || existing.count >= limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(
        (now - existing.lastAt < minIntervalMs
          ? minIntervalMs - (now - existing.lastAt)
          : existing.resetsAt - now) / 1_000,
      ),
    );
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(Code.TOO_MANY_REQUESTS).json({
      success: false,
      message: "Please wait before submitting another inquiry",
      data: { code: "rate_limited", retryAfterSeconds },
    });
    return;
  }

  existing.count += 1;
  existing.lastAt = now;
  next();
};
