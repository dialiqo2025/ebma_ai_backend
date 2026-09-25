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

const emailShell = (content: string, preheader: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>ebma AI</title>
  </head>
  <body style="margin:0;padding:0;background:#070914;font-family:Arial,Helvetica,sans-serif;color:#F2F3FB;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#070914;">
      <tr><td align="center" style="padding:40px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;">
          <tr><td style="padding:0 4px 24px;">
            <span style="font-size:29px;line-height:1;font-weight:800;letter-spacing:-1.5px;color:#9B7AF7;">✦ebma</span>
            <span style="display:inline-block;margin-left:10px;padding-left:10px;border-left:1px solid #3A4267;color:#9AA1C2;font-size:11px;font-weight:700;letter-spacing:2px;vertical-align:4px;">AI</span>
          </td></tr>
          <tr><td style="border:1px solid #2B3358;border-radius:20px;background:#141A30;padding:0;overflow:hidden;">
            <div style="height:5px;background:linear-gradient(90deg,#5B4FE9,#9B5CF6);"></div>
            <div style="padding:42px 42px 38px;">${content}</div>
          </td></tr>
          <tr><td align="center" style="padding:24px 20px 0;color:#565D82;font-size:11px;line-height:18px;">
            Voice and language intelligence for every product and person.<br />
            © ${new Date().getFullYear()} ebma AI. All rights reserved.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

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
    `<div style="display:inline-block;padding:7px 11px;border:1px solid #413A7A;border-radius:999px;background:#1D2444;color:#B7A9FF;font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;">Secure verification</div>
     <h1 style="margin:22px 0 12px;color:#F2F3FB;font-size:30px;line-height:38px;letter-spacing:-0.8px;">${title}</h1>
     <p style="margin:0 0 8px;color:#D5D8E9;font-size:15px;line-height:24px;">Hello ${escapeHtml(params.name || "Builder")},</p>
     <p style="margin:0;color:#9299BD;font-size:14px;line-height:23px;">${messages[params.purpose]}</p>
     <div style="margin:30px 0;padding:24px;border:1px solid #343D68;border-radius:16px;background:#0A0D1A;text-align:center;">
       <div style="margin-bottom:10px;color:#697193;font-size:10px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;">Your one-time code</div>
       <div style="color:#FFFFFF;font-family:'Courier New',monospace;font-size:38px;font-weight:800;letter-spacing:10px;line-height:48px;">${escapeHtml(params.code)}</div>
       <div style="margin-top:10px;color:#8A91B5;font-size:11px;">Expires in ${params.expiresInMinutes} minutes</div>
     </div>
     <div style="padding-top:20px;border-top:1px solid #2B3358;color:#697193;font-size:12px;line-height:19px;">If you did not request this code, you can safely ignore this email. Never share this code with anyone, including ebma AI support.</div>`,
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
  const action = params.actionLabel && params.actionUrl
    ? `<div style="margin-top:28px;"><a href="${escapeHtml(params.actionUrl)}" style="display:inline-block;padding:14px 22px;border-radius:12px;background:#6E5CE7;color:#FFFFFF;text-decoration:none;font-size:13px;font-weight:700;">${escapeHtml(params.actionLabel)}</a></div>`
    : "";

  return emailShell(
    `<div style="display:inline-block;padding:7px 11px;border:1px solid #413A7A;border-radius:999px;background:#1D2444;color:#B7A9FF;font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;">Account update</div>
     <h1 style="margin:22px 0 12px;color:#F2F3FB;font-size:30px;line-height:38px;letter-spacing:-0.8px;">${escapeHtml(params.title)}</h1>
     <p style="margin:0 0 8px;color:#D5D8E9;font-size:15px;line-height:24px;">Hello ${escapeHtml(params.name || "Builder")},</p>
     <p style="margin:0;color:#9299BD;font-size:14px;line-height:23px;">${escapeHtml(params.message)}</p>${action}`,
    params.title,
  );
};

export const sendEmail = async (params: {
  to: string;
  subject: string;
  html: string;
  attachments?: Mail.Attachment[];
}) => {
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
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM || smtpUser,
    to: params.to,
    subject: params.subject,
    html: params.html,
    attachments: params.attachments,
  });
};
