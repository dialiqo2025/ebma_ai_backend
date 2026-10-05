import type { Request, Response } from "express";
import * as Billing from "./billing.provider";
import * as AdminBilling from "./billing.admin.provider";
import { cancelUserSubscription, confirmCheckoutSession, createCheckoutSession, createWalletTopupCheckout, handleStripeWebhook } from "./stripe.service";

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
  plans: async (_req: Request, res: Response) => { const result = await AdminBilling.listPublicPlans(); res.status(result.code).json(result.data); },
  checkout: async (req: Request, res: Response) => {
    try { const result = await createCheckoutSession(userId(req), String(req.body.planUuid)); res.status(200).json({ success: true, message: "Checkout session created", data: result }); }
    catch (error) { res.status(422).json({ success: false, message: error instanceof Error ? error.message : "Unable to create checkout session", data: null }); }
  },
  walletTopupCheckout: async (req: Request, res: Response) => {
    try { const result = await createWalletTopupCheckout(userId(req), Number(req.body.amount)); res.status(200).json({ success: true, message: "Wallet recharge checkout created", data: result }); }
    catch (error) { res.status(422).json({ success: false, message: error instanceof Error ? error.message : "Unable to create wallet recharge", data: null }); }
  },
  confirmCheckout: async (req: Request, res: Response) => {
    try { const result = await confirmCheckoutSession(userId(req), String(req.params.session_id)); res.status(200).json({ success: true, message: "Checkout status confirmed", data: result }); }
    catch (error) { res.status(422).json({ success: false, message: error instanceof Error ? error.message : "Unable to confirm checkout", data: null }); }
  },
  subscriptions: async (req: Request, res: Response) => { const result = await AdminBilling.listUserSubscriptions(userId(req)); res.status(result.code).json(result.data); },
  transactions: async (req: Request, res: Response) => { const result = await AdminBilling.listUserTransactions(userId(req)); res.status(result.code).json(result.data); },
  transaction: async (req: Request, res: Response) => { const result = await AdminBilling.getUserTransaction(userId(req), String(req.params.transaction_uuid)); res.status(result.code).json(result.data); },
  cancelSubscription: async (req: Request, res: Response) => { try { const result = await cancelUserSubscription(userId(req), String(req.params.subscription_uuid)); res.status(200).json({ success: true, message: "Subscription cancellation scheduled", data: result }); } catch (error) { res.status(404).json({ success: false, message: error instanceof Error ? error.message : "Subscription not found", data: null }); } },
  webhook: async (req: Request, res: Response) => {
    try { const type = await handleStripeWebhook(req.body as Buffer, req.headers["stripe-signature"] as string | undefined); res.status(200).json({ received: true, type }); }
    catch (error) { console.error("Stripe webhook failed", error); res.status(400).json({ received: false, message: error instanceof Error ? error.message : "Invalid webhook" }); }
  },
  adminPlans: async (req: Request, res: Response) => {
    const result = req.method === "GET" ? await AdminBilling.listPlans() : await AdminBilling.createPlan(req.body);
    res.status(result.code).json(result.data);
  },
  adminPlanUpdate: async (req: Request, res: Response) => {
    const result = await AdminBilling.updatePlan(String(req.params.plan_uuid), req.body);
    res.status(result.code).json(result.data);
  },
  adminPlanDelete: async (req: Request, res: Response) => {
    const result = await AdminBilling.deletePlan(String(req.params.plan_uuid));
    res.status(result.code).json(result.data);
  },
  adminRates: async (req: Request, res: Response) => {
    const result = req.method === "GET" ? await AdminBilling.listRates() : await AdminBilling.updateRates(req.body);
    res.status(result.code).json(result.data);
  },
  adminSubscriptions: async (_req: Request, res: Response) => { const result = await AdminBilling.listSubscriptions(); res.status(result.code).json(result.data); },
  adminTransactions: async (_req: Request, res: Response) => { const result = await AdminBilling.listTransactions(); res.status(result.code).json(result.data); },
  adminUserWallet: async (req: Request, res: Response) => {
    const result = await AdminBilling.getAdminUserWallet(String(req.params.user_uuid));
    res.status(result.code).json(result.data);
  },
  adminGrantCredits: async (req: Request, res: Response) => {
    const credits = Number(req.body?.credits);
    const note = typeof req.body?.note === "string" ? req.body.note : undefined;
    const result = await AdminBilling.grantAdminUserCredits({
      userUuid: String(req.params.user_uuid),
      credits,
      grantedByUuid: userId(req),
      note,
    });
    res.status(result.code).json(result.data);
  },
  capabilities: async (req: Request, res: Response) => { const result = await AdminBilling.getUserCapabilities(userId(req)); res.status(result.code).json(result.data); },
};
