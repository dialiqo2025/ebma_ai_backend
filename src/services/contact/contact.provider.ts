import { randomUUID } from "crypto";
import {
  customPricingRecipient,
  renderEbmaContactInquiryEmail,
  sendEmail,
} from "../../utils/email.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import { GenResObj } from "../../utils/responseFormat.util";
import type { ContactInquiryInput } from "./contact.validate";

const inquiryLabels: Record<ContactInquiryInput["inquiryType"], string> = {
  custom_pricing: "Custom pricing",
  sales: "Sales inquiry",
  partnership: "Partnership",
  support: "Product support",
  general: "General inquiry",
};

const serviceLabels = { stt: "Speech to Text", tts: "Text to Speech", llm: "LLM Assistant" };

const usageLabels: Record<ContactInquiryInput["monthlyUsage"], string> = {
  exploring: "Exploring / prototype",
  small: "Up to 1,000 units",
  growing: "1,000–10,000 units",
  high_volume: "More than 10,000 units",
  not_sure: "Not sure yet",
};

export const submitContactInquiry = async (input: ContactInquiryInput) => {
  const reference = randomUUID().slice(0, 8).toUpperCase();
  const inquiryType = inquiryLabels[input.inquiryType];
  const services = input.services.map((service) => serviceLabels[service]);
  const monthlyUsage = usageLabels[input.monthlyUsage];
  const submittedAt = new Date();
  const html = renderEbmaContactInquiryEmail({
    fullName: input.fullName,
    email: input.workEmail,
    company: input.company,
    jobTitle: input.jobTitle,
    phone: input.phone,
    inquiryType,
    services,
    monthlyUsage,
    message: input.message,
    submittedAt,
    reference,
  });

  await sendEmail({
    to: customPricingRecipient(),
    replyTo: input.workEmail,
    subject: `[${reference}] ${inquiryType} — ${input.company}`,
    text: [
      `Inquiry reference: ${reference}`,
      `Name: ${input.fullName}`,
      `Email: ${input.workEmail}`,
      `Company: ${input.company}`,
      `Job title: ${input.jobTitle || "Not provided"}`,
      `Phone: ${input.phone || "Not provided"}`,
      `Inquiry: ${inquiryType}`,
      `Services: ${services.join(", ") || "Not specified"}`,
      `Monthly usage: ${monthlyUsage}`,
      "",
      input.message,
    ].join("\n"),
    html,
  });

  return GenResObj(Code.CREATED, true, "Your inquiry has been sent", { reference });
};
