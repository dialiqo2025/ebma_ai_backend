import nodemailer from "nodemailer";
import Mail from "nodemailer/lib/mailer";

export type OtpPurpose = "signup" | "login" | "password_reset";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const multiline = (value: string) => escapeHtml(value).replaceAll("\n", "<br />");

const siteUrl = () =>
  (process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "https://ebma.ai")
    .trim()
    .replace(/\/$/, "");

export const customPricingRecipient = () =>
  process.env.CUSTOM_PRICING_TO_EMAIL?.trim() || "hello@ebma.ai";

type EmailProvider = "resend" | "smtp";

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const emailDeliveryProvider = (): EmailProvider => {
  const configured = (process.env.EMAIL_PROVIDER || "auto").trim().toLowerCase();
  if (configured === "auto") {
    return process.env.RESEND_API_KEY?.trim() ? "resend" : "smtp";
  }
  if (configured === "resend" || configured === "smtp") return configured;
  throw new Error("EMAIL_PROVIDER must be auto, resend, or smtp");
};

const emailShell = (content: string, preheader: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&amp;family=Space+Grotesk:wght@600;700&amp;display=swap" rel="stylesheet" />
    <title>ebma AI</title>
  </head>
  <body style="margin:0;padding:0;background:#F3F0FF;font-family:Inter,'Segoe UI',Arial,Helvetica,sans-serif;color:#1D1B2E;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#F3F0FF;">
      <tr><td align="center" style="padding:38px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:620px;">
          <tr><td style="padding:0 8px 22px;">
            <img src="${escapeHtml(`${siteUrl()}/ebma-logo-light.png`)}" width="174" alt="ebma.ai" style="display:block;width:174px;max-width:100%;height:auto;border:0;" />
          </td></tr>
          <tr><td style="overflow:hidden;border:1px solid #DDD6F5;border-radius:22px;background:#FFFFFF;box-shadow:0 18px 50px rgba(77,50,200,.10);">
            <div style="height:6px;background-color:#6542E8;background-image:linear-gradient(90deg,#4D32C8,#6542E8 58%,#B7A5FF);"></div>
            <div style="padding:42px 42px 38px;">${content}</div>
          </td></tr>
          <tr><td align="center" style="padding:24px 20px 0;color:#8B849C;font-size:11px;line-height:18px;">
            Voice and language intelligence for every product and person.<br />
            <span style="color:#6542E8;">ebma.ai</span> &nbsp;·&nbsp; © ${new Date().getFullYear()} ebma AI
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

const eyebrow = (label: string) =>
  `<div style="display:inline-block;padding:7px 11px;border:1px solid #D7CDFB;border-radius:999px;background:#F3F0FF;color:#6542E8;font-size:10px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;">${escapeHtml(label)}</div>`;

export const renderEbmaOtpEmail = (params: {
  name: string;
  code: string;
  purpose: OtpPurpose;
  expiresInMinutes: number;
}) => {
  const titles: Record<OtpPurpose, string> = {
    signup: "Verify your email",
    login: "Confirm your sign-in",
    password_reset: "Reset your password",
  };
  const messages: Record<OtpPurpose, string> = {
    signup: "Use this code to verify your email and finish creating your ebma AI workspace.",
    login: "Use this code to securely complete your sign-in to ebma AI.",
    password_reset: "Use this code to continue resetting your ebma AI password.",
  };
  const title = titles[params.purpose];

  return emailShell(
    `${eyebrow("Secure verification")}
     <h1 style="margin:22px 0 12px;color:#1D1B2E;font-family:'Space Grotesk',Inter,'Segoe UI',Arial,sans-serif;font-size:31px;line-height:39px;letter-spacing:-.8px;">${title}</h1>
     <p style="margin:0 0 8px;color:#343247;font-size:15px;line-height:24px;">Hello ${escapeHtml(params.name || "Builder")},</p>
     <p style="margin:0;color:#667085;font-size:14px;line-height:23px;">${messages[params.purpose]}</p>
     <div style="margin:30px 0;padding:25px;border:1px solid #DDD6F5;border-radius:17px;background:#F8F7FF;text-align:center;">
       <div style="margin-bottom:10px;color:#8B849C;font-size:10px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;">Your one-time code</div>
       <div style="color:#4D32C8;font-family:'Courier New',monospace;font-size:38px;font-weight:800;letter-spacing:10px;line-height:48px;">${escapeHtml(params.code)}</div>
       <div style="margin-top:10px;color:#667085;font-size:11px;">Expires in ${params.expiresInMinutes} minutes</div>
     </div>
     <div style="padding-top:20px;border-top:1px solid #E8E3F7;color:#8B849C;font-size:12px;line-height:19px;">If you did not request this code, you can safely ignore this email. Never share it with anyone, including ebma AI support.</div>`,
    `${params.code} is your ebma AI verification code.`,
  );
};

export const renderEbmaNoticeEmail = (params: {
  name: string;
  title: string;
  message: string;
  actionLabel?: string;
  actionUrl?: string;
}) => {
  const action =
    params.actionLabel && params.actionUrl
      ? `<div style="margin-top:28px;"><a href="${escapeHtml(params.actionUrl)}" style="display:inline-block;padding:14px 22px;border-radius:12px;background-color:#6542E8;background-image:linear-gradient(100deg,#4D32C8,#6542E8);color:#FFFFFF;text-decoration:none;font-size:13px;font-weight:800;">${escapeHtml(params.actionLabel)}</a></div>`
      : "";

  return emailShell(
    `${eyebrow("Account update")}
     <h1 style="margin:22px 0 12px;color:#1D1B2E;font-family:'Space Grotesk',Inter,'Segoe UI',Arial,sans-serif;font-size:31px;line-height:39px;letter-spacing:-.8px;">${escapeHtml(params.title)}</h1>
     <p style="margin:0 0 8px;color:#343247;font-size:15px;line-height:24px;">Hello ${escapeHtml(params.name || "Builder")},</p>
     <p style="margin:0;color:#667085;font-size:14px;line-height:23px;">${escapeHtml(params.message)}</p>${action}`,
    params.title,
  );
};

const detailRow = (label: string, value: string) =>
  `<tr>
    <td style="width:145px;padding:10px 14px 10px 0;border-bottom:1px solid #ECE8F8;color:#8B849C;font-size:11px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:10px 0;border-bottom:1px solid #ECE8F8;color:#343247;font-size:13px;line-height:20px;vertical-align:top;">${escapeHtml(value || "Not provided")}</td>
  </tr>`;

export const renderEbmaContactInquiryEmail = (params: {
  fullName: string;
  email: string;
  company: string;
  jobTitle?: string;
  phone?: string;
  inquiryType: string;
  services: string[];
  monthlyUsage?: string;
  message: string;
  submittedAt: Date;
  reference: string;
}) =>
  emailShell(
    `${eyebrow("New website inquiry")}
     <h1 style="margin:22px 0 10px;color:#1D1B2E;font-family:'Space Grotesk',Inter,'Segoe UI',Arial,sans-serif;font-size:31px;line-height:39px;letter-spacing:-.8px;">A new conversation starts here.</h1>
     <p style="margin:0;color:#667085;font-size:14px;line-height:23px;">${escapeHtml(params.fullName)} submitted an inquiry through the ebma AI website.</p>
     <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:26px;border-top:1px solid #ECE8F8;">
       ${detailRow("Reference", params.reference)}
       ${detailRow("Name", params.fullName)}
       ${detailRow("Work email", params.email)}
       ${detailRow("Company", params.company)}
       ${detailRow("Job title", params.jobTitle || "Not provided")}
       ${detailRow("Phone", params.phone || "Not provided")}
       ${detailRow("Inquiry", params.inquiryType)}
       ${detailRow("Services", params.services.length ? params.services.join(", ") : "Not specified")}
       ${detailRow("Monthly usage", params.monthlyUsage || "Not sure yet")}
       ${detailRow("Submitted", params.submittedAt.toISOString())}
     </table>
     <div style="margin-top:26px;padding:20px;border:1px solid #DDD6F5;border-radius:16px;background:#F8F7FF;">
       <div style="margin-bottom:9px;color:#6542E8;font-size:10px;font-weight:800;letter-spacing:1.1px;text-transform:uppercase;">Requirements</div>
       <div style="color:#343247;font-size:14px;line-height:23px;">${multiline(params.message)}</div>
     </div>
     <div style="margin-top:28px;"><a href="mailto:${escapeHtml(params.email)}" style="display:inline-block;padding:14px 22px;border-radius:12px;background-color:#6542E8;background-image:linear-gradient(100deg,#4D32C8,#6542E8);color:#FFFFFF;text-decoration:none;font-size:13px;font-weight:800;">Reply to ${escapeHtml(params.fullName)}</a></div>`,
    `New ${params.inquiryType} inquiry from ${params.fullName} at ${params.company}.`,
  );

export const sendEmail = async (params: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  attachments?: Mail.Attachment[];
}) => {
  const provider = emailDeliveryProvider();
  if (provider === "resend") {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = (process.env.RESEND_FROM || process.env.SMTP_FROM)?.trim();
    if (!apiKey || !from) {
      throw new Error("RESEND_API_KEY and RESEND_FROM must be configured");
    }
    if (params.attachments?.length) {
      throw new Error("Attachments are not configured for the Resend email provider");
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      positiveInteger(process.env.EMAIL_TIMEOUT_MS, 15_000),
    );

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [params.to],
          reply_to: params.replyTo,
          subject: params.subject,
          text: params.text,
          html: params.html,
        }),
        signal: controller.signal,
      });

      const result = (await response.json().catch(() => null)) as
        | { id?: string; message?: string; name?: string }
        | null;
      if (!response.ok) {
        throw new Error(
          `Resend delivery failed (${response.status}): ${result?.message || result?.name || "Unknown provider response"}`,
        );
      }
      return;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Email provider request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  const smtpPort = Number(process.env.SMTP_PORT ?? 587);
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost || !smtpUser || !smtpPass) {
    throw new Error("SMTP_HOST, SMTP_USER and SMTP_PASS must be configured");
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
    connectionTimeout: positiveInteger(process.env.EMAIL_TIMEOUT_MS, 15_000),
    greetingTimeout: positiveInteger(process.env.EMAIL_TIMEOUT_MS, 15_000),
    socketTimeout: positiveInteger(process.env.EMAIL_TIMEOUT_MS, 15_000),
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM || smtpUser,
    to: params.to,
    replyTo: params.replyTo,
    subject: params.subject,
    text: params.text,
    html: params.html,
    attachments: params.attachments,
  });
};
