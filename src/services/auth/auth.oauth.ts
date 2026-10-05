import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { Users } from "../../schema";
import {
  createAccessToken,
  getUserByAppleId,
  getUserByEmail,
  getUserByGoogleId,
  getUserByMicrosoftId,
  normalizeEmail,
  sanitizeUser,
} from "./auth.helper";

type GoogleProfile = {
  sub: string;
  email: string;
  name?: string;
  given_name?: string;
  family_name?: string;
};

type OAuthProvider = "google" | "microsoft" | "apple";

type OAuthIdentity = {
  provider: OAuthProvider;
  providerId: string;
  email?: string | null;
  fullName?: string | null;
};

export const clientOAuthRedirect = () =>
  process.env.CLIENT_OAUTH_REDIRECT?.trim() ||
  `${(process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "")}/oauth-success`;

export const oauthFailRedirect = (message: string) => {
  const fail = new URL(clientOAuthRedirect());
  fail.searchParams.set("error", message);
  return fail.toString();
};

const completeOAuthLogin = async (identity: OAuthIdentity) => {
  const providerId = identity.providerId.trim();
  if (!providerId) {
    return { ok: false as const, message: `${identity.provider} account is missing an id` };
  }

  const email = identity.email ? normalizeEmail(identity.email) : null;
  const fullName =
    identity.fullName?.trim() ||
    (email ? email.split("@")[0] : null) ||
    `${identity.provider.charAt(0).toUpperCase()}${identity.provider.slice(1)} User`;

  let user =
    identity.provider === "google"
      ? await getUserByGoogleId(providerId)
      : identity.provider === "microsoft"
        ? await getUserByMicrosoftId(providerId)
        : await getUserByAppleId(providerId);

  if (!user && email) {
    user = await getUserByEmail(email);
  }

  if (user) {
    if (!user.user_enabled) {
      return { ok: false as const, message: "This account has been disabled" };
    }

    const patch: Partial<typeof Users.$inferInsert> = {
      email_verified: true,
      fullName: user.fullName || fullName,
      last_login: new Date(),
      updated_at: new Date(),
      auth_provider: user.auth_provider === "email" ? "email" : identity.provider,
    };
    if (identity.provider === "google") patch.google_id = providerId;
    if (identity.provider === "microsoft") patch.microsoft_id = providerId;
    if (identity.provider === "apple") patch.apple_id = providerId;

    const [updated] = await db
      .update(Users)
      .set(patch)
      .where(eq(Users.user_uuid, user.user_uuid))
      .returning();
    user = updated ?? user;
  } else {
    if (!email) {
      return {
        ok: false as const,
        message: `${identity.provider} did not return an email. Allow email access and try again.`,
      };
    }

    const insertValues: typeof Users.$inferInsert = {
      fullName,
      email,
      password: null,
      auth_provider: identity.provider,
      role: "user",
      email_verified: true,
      last_login: new Date(),
      ...(identity.provider === "google" ? { google_id: providerId } : {}),
      ...(identity.provider === "microsoft" ? { microsoft_id: providerId } : {}),
      ...(identity.provider === "apple" ? { apple_id: providerId } : {}),
    };
    const [created] = await db.insert(Users).values(insertValues).returning();
    if (!created) return { ok: false as const, message: "Unable to create account" };
    user = created;
  }

  const token = createAccessToken(user.user_uuid, user.role);
  const redirectUrl = new URL(clientOAuthRedirect());
  redirectUrl.searchParams.set("token", token);
  redirectUrl.searchParams.set(
    "user",
    Buffer.from(JSON.stringify(sanitizeUser(user))).toString("base64url"),
  );

  return { ok: true as const, redirectUrl: redirectUrl.toString() };
};

const googleConfig = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const callbackUrl =
    process.env.GOOGLE_CALLBACK_URL?.trim() ||
    `http://localhost:${process.env.PORT || 5001}/api/v1/auth/google/callback`;

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured");
  }

  return { clientId, clientSecret, callbackUrl };
};

export const getGoogleAuthUrl = () => {
  const { clientId, callbackUrl } = googleConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
};

export const handleGoogleCallback = async (code?: string) => {
  if (!code) {
    return { ok: false as const, message: "Missing Google authorization code" };
  }

  const { clientId, clientSecret, callbackUrl } = googleConfig();

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    console.error("Google token exchange failed:", await tokenResponse.text());
    return { ok: false as const, message: "Google authentication failed" };
  }

  const tokenPayload = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenPayload.access_token) {
    return { ok: false as const, message: "Google authentication failed" };
  }

  const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
  });

  if (!profileResponse.ok) {
    return { ok: false as const, message: "Unable to load Google profile" };
  }

  const profile = (await profileResponse.json()) as GoogleProfile;
  if (!profile.sub) {
    return { ok: false as const, message: "Google account is missing an id" };
  }

  const fullName =
    profile.name?.trim() ||
    [profile.given_name, profile.family_name].filter(Boolean).join(" ").trim() ||
    null;

  return completeOAuthLogin({
    provider: "google",
    providerId: profile.sub,
    email: profile.email,
    fullName,
  });
};

const microsoftConfig = () => {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  const tenant = process.env.MICROSOFT_TENANT_ID?.trim() || "common";
  const callbackUrl =
    process.env.MICROSOFT_CALLBACK_URL?.trim() ||
    `http://localhost:${process.env.PORT || 5001}/api/v1/auth/microsoft/callback`;

  if (!clientId) {
    throw new Error("MICROSOFT_CLIENT_ID must be set in the backend .env");
  }
  if (!clientSecret) {
    throw new Error(
      "MICROSOFT_CLIENT_SECRET is missing. In Azure → App registration → Certificates & secrets, create a client secret and add it to the backend .env",
    );
  }

  return { clientId, clientSecret, tenant, callbackUrl };
};

export const getMicrosoftAuthUrl = () => {
  const { clientId, tenant, callbackUrl } = microsoftConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: callbackUrl,
    response_mode: "query",
    scope: "openid profile email User.Read",
    prompt: "select_account",
  });
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params.toString()}`;
};

export const handleMicrosoftCallback = async (code?: string) => {
  if (!code) {
    return { ok: false as const, message: "Missing Microsoft authorization code" };
  }

  const { clientId, clientSecret, tenant, callbackUrl } = microsoftConfig();

  const tokenResponse = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
        grant_type: "authorization_code",
        scope: "openid profile email User.Read",
      }),
    },
  );

  if (!tokenResponse.ok) {
    const raw = await tokenResponse.text();
    console.error("Microsoft token exchange failed:", raw);
    let message = "Microsoft authentication failed";
    try {
      const err = JSON.parse(raw) as { error?: string; error_description?: string };
      if (err.error === "invalid_client") {
        message = "Invalid Microsoft client ID or client secret. Check backend .env and Azure secrets.";
      } else if (err.error_description?.toLowerCase().includes("redirect_uri")) {
        message =
          "Microsoft redirect URI mismatch. In Azure, add Web redirect URI: http://localhost:5001/api/v1/auth/microsoft/callback";
      } else if (err.error_description) {
        message = err.error_description.slice(0, 200);
      }
    } catch {
      // keep default message
    }
    return { ok: false as const, message };
  }

  const tokenPayload = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenPayload.access_token) {
    return { ok: false as const, message: "Microsoft authentication failed" };
  }

  const profileResponse = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
  });

  if (!profileResponse.ok) {
    return { ok: false as const, message: "Unable to load Microsoft profile" };
  }

  const profile = (await profileResponse.json()) as {
    id?: string;
    mail?: string | null;
    userPrincipalName?: string | null;
    displayName?: string | null;
  };

  if (!profile.id) {
    return { ok: false as const, message: "Microsoft account is missing an id" };
  }

  return completeOAuthLogin({
    provider: "microsoft",
    providerId: profile.id,
    email: profile.mail || profile.userPrincipalName || null,
    fullName: profile.displayName ?? null,
  });
};

const appleConfig = () => {
  const clientId = process.env.APPLE_CLIENT_ID?.trim();
  const teamId = process.env.APPLE_TEAM_ID?.trim();
  const keyId = process.env.APPLE_KEY_ID?.trim();
  const privateKeyRaw = process.env.APPLE_PRIVATE_KEY?.trim();
  const callbackUrl =
    process.env.APPLE_CALLBACK_URL?.trim() ||
    `http://localhost:${process.env.PORT || 5001}/api/v1/auth/apple/callback`;

  if (!clientId || !teamId || !keyId || !privateKeyRaw) {
    throw new Error(
      "APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY must be configured",
    );
  }

  const privateKey = privateKeyRaw.includes("\\n")
    ? privateKeyRaw.replace(/\\n/g, "\n")
    : privateKeyRaw;

  return { clientId, teamId, keyId, privateKey, callbackUrl };
};

const createAppleClientSecret = () => {
  const { clientId, teamId, keyId, privateKey } = appleConfig();
  return jwt.sign({}, privateKey, {
    algorithm: "ES256",
    expiresIn: "15777000",
    audience: "https://appleid.apple.com",
    issuer: teamId,
    subject: clientId,
    keyid: keyId,
  });
};

export const getAppleAuthUrl = () => {
  const { clientId, callbackUrl } = appleConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: "code id_token",
    response_mode: "form_post",
    scope: "name email",
  });
  return `https://appleid.apple.com/auth/authorize?${params.toString()}`;
};

export type AppleCallbackInput = {
  code?: string;
  idToken?: string;
  userJson?: string;
};

export const handleAppleCallback = async (input: AppleCallbackInput) => {
  if (!input.code) {
    return { ok: false as const, message: "Missing Apple authorization code" };
  }

  const { clientId, callbackUrl } = appleConfig();
  let clientSecret: string;
  try {
    clientSecret = createAppleClientSecret();
  } catch (error) {
    console.error("Apple client secret generation failed:", error);
    return { ok: false as const, message: "Apple authentication is misconfigured" };
  }

  const tokenResponse = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl,
    }),
  });

  if (!tokenResponse.ok) {
    console.error("Apple token exchange failed:", await tokenResponse.text());
    return { ok: false as const, message: "Apple authentication failed" };
  }

  const tokenPayload = (await tokenResponse.json()) as { id_token?: string };
  const idToken = tokenPayload.id_token || input.idToken;
  if (!idToken) {
    return { ok: false as const, message: "Apple authentication failed" };
  }

  const decoded = jwt.decode(idToken) as { sub?: string; email?: string } | null;
  if (!decoded?.sub) {
    return { ok: false as const, message: "Apple account is missing an id" };
  }

  let fullName: string | null = null;
  if (input.userJson) {
    try {
      const userPayload = JSON.parse(input.userJson) as {
        name?: { firstName?: string; lastName?: string };
      };
      fullName =
        [userPayload.name?.firstName, userPayload.name?.lastName]
          .filter(Boolean)
          .join(" ")
          .trim() || null;
    } catch {
      // Name is only sent on the first Apple authorize.
    }
  }

  return completeOAuthLogin({
    provider: "apple",
    providerId: decoded.sub,
    email: decoded.email || null,
    fullName,
  });
};
