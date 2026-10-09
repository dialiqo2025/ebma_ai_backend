import { createHash } from "crypto";
import type { Request } from "express";

const salt = () =>
  process.env.PLAYGROUND_IP_SALT?.trim() ||
  process.env.JWT_SECRET?.trim() ||
  "ebma-playground-dev-salt";

export const clientIpFromRequest = (req: Request): string => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim() || req.ip || "unknown";
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(",")[0]?.trim() || req.ip || "unknown";
  }
  return req.ip || req.socket.remoteAddress || "unknown";
};

export const hashClientIp = (ip: string): string =>
  createHash("sha256").update(`${salt()}:${ip}`).digest("hex");
