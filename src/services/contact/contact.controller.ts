import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import * as ContactProvider from "./contact.provider";
import { contactInquiryValidator } from "./contact.validate";

export const ContactController = {
  submit: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = contactInquiryValidator.parse(req.body);
      if (payload.website) {
        res.status(Code.CREATED).json({
          success: true,
          message: "Your inquiry has been sent",
          data: { reference: null },
        });
        return;
      }
      const result = await ContactProvider.submitContactInquiry(payload);
      res.status(result.code).json(result.data);
    } catch (error) {
      if (error instanceof ZodError) {
        next(error);
        return;
      }
      console.error("Contact inquiry delivery failed", error);
      res.status(Code.SERVICE_UNAVAILABLE).json({
        success: false,
        message: "We could not send your inquiry right now. Please try again shortly.",
        data: null,
      });
    }
  },
};
