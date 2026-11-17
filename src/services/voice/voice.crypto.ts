import { createCipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Shared secret between this backend and the EBMA LiveKit voice agent.
 * The agent must be configured with the same value (EBMA_METADATA_SECRET and
 * EBMA_EVENTS_WEBHOOK_SECRET on the agent side).
 */
export const agentSharedSecret = () => process.env.EBMA_AGENT_SHARED_SECRET?.trim() || "";

const aesKey = (secret: string) => createHash("sha256").update(secret, "utf8").digest();

/**
 * Encrypt the per-session agent configuration (it contains the user's LLM API key).
 * AES-256-GCM, key = SHA-256(shared secret), additional authenticated data = room name,
 * so a payload is only valid for the room it was issued for.
 * Wire format: {"v":1,"alg":"A256GCM","iv":"<b64>","ct":"<b64 ciphertext||tag>"}
 */
export const encryptAgentMetadata = (payload: Record<string, unknown>, roomName: string) => {
  const secret = agentSharedSecret();
  if (!secret) throw new Error("EBMA_AGENT_SHARED_SECRET is not configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey(secret), iv);
  cipher.setAAD(Buffer.from(roomName, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ v: 1, alg: "A256GCM", iv: iv.toString("base64"), ct: ciphertext.toString("base64") });
};

/** Verify an agent event: X-EBMA-Signature = "sha256=" + HMAC-SHA256(secret, `${timestamp}.${rawBody}`). */
export const verifyAgentEventSignature = (rawBody: Buffer, timestamp: string | undefined, signature: string | undefined) => {
  const secret = agentSharedSecret();
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Opaque owner tag stored in (client-visible) room metadata instead of the raw user id. */
export const ownerTag = (userUuid: string) =>
  createHmac("sha256", agentSharedSecret() || "ebma-voice").update(`owner:${userUuid}`).digest("hex").slice(0, 32);
