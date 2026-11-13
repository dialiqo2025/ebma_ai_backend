import type { NextFunction, Request, Response } from "express";
import { currentRequestContext } from "./observability.context";
import { recordApiTransaction } from "./observability.provider";

const extractModule = (requestPath: string) => (requestPath.split("?", 1)[0] || "").split("/").filter(Boolean)[2] || "core";

export const apiTransactionMonitor = (req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/api/v1/observability")) return next();
  const startedAt = Date.now();
  let responseBody: any;
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    responseBody = body;
    return originalJson(body);
  }) as typeof res.json;

  res.once("finish", () => {
    const context = currentRequestContext();
    const successful = res.statusCode < 400 && responseBody?.success !== false;
    const message = typeof responseBody?.message === "string"
      ? responseBody.message
      : `${req.method} ${req.path} ${successful ? "completed successfully" : "failed"}`;
    const error = responseBody?.data?.error;
    void recordApiTransaction({
      requestId: context?.requestId || "00000000-0000-0000-0000-000000000000",
      userUuid: req.user?.userId,
      apiKeyUuid: req.user?.apiKeyId,
      method: req.method,
      path: req.originalUrl,
      module: extractModule(req.originalUrl),
      functionality: `${req.method} ${req.route?.path || req.path}`,
      status: successful ? "success" : "failed",
      httpStatus: res.statusCode,
      description: message,
      errorCode: error?.code || responseBody?.data?.code,
      errorMessage: successful ? undefined : error?.message || message,
      requestMetadata: {
        query: req.query,
        params: req.params,
        body: req.body,
        file: req.file ? { originalName: req.file.originalname, contentType: req.file.mimetype, size: req.file.size } : undefined,
      },
      responseMetadata: responseBody,
      ...(req.ip ? { ipAddress: req.ip } : {}),
      ...(req.get("user-agent") ? { userAgent: req.get("user-agent")! } : {}),
      durationMs: Date.now() - startedAt,
    }).catch((error) => console.error("API transaction monitoring failed:", error));
  });
  next();
};
