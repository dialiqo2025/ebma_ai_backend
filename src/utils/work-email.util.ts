/**
 * Hybrid work-email signup gate:
 * - Blocks free / disposable mailbox domains for *new* signups
 * - Existing accounts (any domain) can still sign in / finish verification
 * - Optional allowlist overrides the block for specific company domains
 */

const WORK_EMAIL_MESSAGE =
  "Use your work email. Personal or temporary addresses (Gmail, Outlook, Yopmail, etc.) aren’t supported for new accounts.";

/** Common free consumer + disposable / temporary mailbox providers. */
const BUILTIN_BLOCKED_DOMAINS = [
  // Google
  "gmail.com",
  "googlemail.com",
  // Microsoft consumer
  "outlook.com",
  "outlook.in",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "live.com",
  "live.in",
  "msn.com",
  // Yahoo / AOL
  "yahoo.com",
  "yahoo.co.in",
  "yahoo.co.uk",
  "ymail.com",
  "aol.com",
  // Apple
  "icloud.com",
  "me.com",
  "mac.com",
  // Other consumer
  "proton.me",
  "protonmail.com",
  "zoho.com",
  "zohomail.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "inbox.com",
  "rediffmail.com",
  // Disposable / temp
  "yopmail.com",
  "yopmail.fr",
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.net",
  "guerrillamail.org",
  "sharklasers.com",
  "grr.la",
  "tempmail.com",
  "temp-mail.org",
  "temp-mail.io",
  "10minutemail.com",
  "10minutemail.net",
  "trashmail.com",
  "trashmail.me",
  "discard.email",
  "discardmail.com",
  "mailnesia.com",
  "maildrop.cc",
  "getnada.com",
  "nada.email",
  "emailondeck.com",
  "fakeinbox.com",
  "throwawaymail.com",
  "moakt.com",
  "mintemail.com",
  "mytemp.email",
  "tmpmail.org",
  "tmpmail.net",
  "dispostable.com",
  "mailcatch.com",
  "mailnull.com",
  "spamgourmet.com",
  "sharkemail.com",
] as const;

const parseDomainList = (raw: string | undefined) =>
  (raw || "")
    .split(",")
    .map((part) => part.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);

const blockedDomainSet = () => {
  const set = new Set<string>(BUILTIN_BLOCKED_DOMAINS);
  for (const domain of parseDomainList(process.env.SIGNUP_BLOCKED_EMAIL_DOMAINS)) {
    set.add(domain);
  }
  return set;
};

const allowedDomainSet = () => new Set(parseDomainList(process.env.SIGNUP_ALLOWED_EMAIL_DOMAINS));

export const workEmailSignupEnabled = () => {
  const raw = (process.env.SIGNUP_REQUIRE_WORK_EMAIL || "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
};

export const extractEmailDomain = (email: string) => {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return null;
  const domain = normalized.slice(at + 1).replace(/\.+$/, "");
  if (!domain || domain.includes(" ") || !domain.includes(".")) return null;
  return domain;
};

export const isBlockedSignupEmailDomain = (email: string) => {
  const domain = extractEmailDomain(email);
  if (!domain) return true;
  if (allowedDomainSet().has(domain)) return false;
  return blockedDomainSet().has(domain);
};

export type WorkEmailGateResult =
  | { ok: true }
  | { ok: false; message: string; code: "work_email_required" };

/** Reject free/disposable domains for new account creation. */
export const assertWorkEmailForSignup = (email: string): WorkEmailGateResult => {
  if (!workEmailSignupEnabled()) return { ok: true };
  if (!isBlockedSignupEmailDomain(email)) return { ok: true };
  return { ok: false, message: WORK_EMAIL_MESSAGE, code: "work_email_required" };
};

export const WORK_EMAIL_REQUIRED_MESSAGE = WORK_EMAIL_MESSAGE;
