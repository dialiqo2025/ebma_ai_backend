import { renderEbmaNoticeEmail, sendEmail } from "../../utils/email.util";

export const sendUserCreatedEmail = async (params: {
  to: string;
  name: string;
  email: string;
  password: string;
  role: string;
  tenantName?: string;
}) => {
  const html = renderEbmaNoticeEmail({
    name: params.name,
    title: "Your ebma AI account is ready",
    message: `An ebma AI account has been created for ${params.email}. Sign in using the credentials provided securely by your administrator.`,
    actionLabel: "Open ebma AI",
    actionUrl: process.env.LOGIN_URL || "http://localhost:3000/auth",
  });

  await sendEmail({
    to: params.to,
    subject: "Your ebma AI account is ready",
    html,
  });
};

export const sendUserPasswordUpdatedEmail = async (params: {
  to: string;
  name: string;
  email: string;
  password: string;
  role: string;
  tenantName?: string;
}) => {
  const html = renderEbmaNoticeEmail({
    name: params.name,
    title: "Your password was updated",
    message: "The password for your ebma AI account was changed successfully. If you did not make this change, contact support immediately.",
    actionLabel: "Sign in to ebma AI",
    actionUrl: process.env.LOGIN_URL || "http://localhost:3000/auth",
  });

  await sendEmail({
    to: params.to,
    subject: "Your ebma AI password was updated",
    html,
  });
};
