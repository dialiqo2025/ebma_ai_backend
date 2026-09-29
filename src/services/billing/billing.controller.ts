import type { Request, Response } from "express";
import * as Billing from "./billing.provider";

const userId = (req: Request) => req.user?.userId as string;
export const BillingController = {
  summary: async (req: Request, res: Response) => { const result = await Billing.getBillingSummary(userId(req)); res.status(result.code).json(result.data); },
  usage: async (req: Request, res: Response) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const rawType = String(req.query.type || "");
    const type = ["tts_characters", "stt_seconds", "llm_tokens"].includes(rawType) ? rawType as "tts_characters" | "stt_seconds" | "llm_tokens" : undefined;
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(`${String(req.query.to)}T23:59:59.999Z`) : undefined;
    const result = await Billing.listBillingUsage(userId(req), page, 20, {
      ...(type ? { type } : {}),
      ...(from && !Number.isNaN(from.valueOf()) ? { from } : {}),
      ...(to && !Number.isNaN(to.valueOf()) ? { to } : {}),
    });
    res.status(result.code).json(result.data);
  },
};
