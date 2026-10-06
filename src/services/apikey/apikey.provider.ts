import crypto from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { ApiKeys, type ApiKeyScope } from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";

export const API_KEY_PREFIX = "ebma_sk_";
const MAX_ACTIVE_KEYS = 10;
const ALL_SCOPES: ApiKeyScope[] = ["stt", "tts", "llm", "translate"];

export const hashApiKey = (key: string) => crypto.createHash("sha256").update(key).digest("hex");

const publicKey = (row: typeof ApiKeys.$inferSelect) => ({
  key_uuid: row.key_uuid,
  name: row.name,
  prefix: row.key_prefix,
  scopes: row.scopes,
  last_used_at: row.last_used_at,
  expires_at: row.expires_at,
  revoked_at: row.revoked_at,
  created_at: row.created_at,
});

const parseScopes = (input: unknown): ApiKeyScope[] | null => {
  if (input === undefined) return ALL_SCOPES;
  if (!Array.isArray(input)) return null;
  const scopes = [...new Set(input)].filter((s): s is ApiKeyScope => ALL_SCOPES.includes(s));
  return scopes.length && scopes.length === input.length ? scopes : null;
};

const parseName = (input: unknown) => (typeof input === "string" ? input.trim().slice(0, 100) : "");

export const listKeys = async (userUuid: string) => {
  const rows = await db.select().from(ApiKeys).where(eq(ApiKeys.user_uuid, userUuid)).orderBy(desc(ApiKeys.created_at));
  return GenResObj(Code.OK, true, "API keys fetched successfully", rows.map(publicKey));
};

export const createKey = async (userUuid: string, input: { name?: unknown; scopes?: unknown; expiresInDays?: unknown }) => {
  const name = parseName(input.name);
  if (!name) return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "A key name is required");
  const scopes = parseScopes(input.scopes);
  if (!scopes) return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "Scopes must be a non-empty list of stt, tts, llm, translate");
  let expiresAt: Date | null = null;
  if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
    const days = Number(input.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "Expiry must be between 1 and 365 days");
    expiresAt = new Date(Date.now() + days * 86_400_000);
  }

  const active = await db.select({ key_uuid: ApiKeys.key_uuid }).from(ApiKeys).where(and(eq(ApiKeys.user_uuid, userUuid), isNull(ApiKeys.revoked_at)));
  if (active.length >= MAX_ACTIVE_KEYS) return GenResObj(Code.UNPROCESSABLE_ENTITY, false, `You can have at most ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);

  const secret = `${API_KEY_PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
  const [row] = await db.insert(ApiKeys).values({
    user_uuid: userUuid,
    name,
    key_prefix: `${secret.slice(0, API_KEY_PREFIX.length + 6)}…`,
    key_hash: hashApiKey(secret),
    scopes,
    expires_at: expiresAt,
  }).returning();
  // The full secret is only returned here; only its hash is stored.
  return GenResObj(Code.CREATED, true, "API key created. Copy it now; it will not be shown again.", { ...publicKey(row!), secret });
};

export const renameKey = async (userUuid: string, keyUuid: string, input: { name?: unknown }) => {
  const name = parseName(input.name);
  if (!name) return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "A key name is required");
  const [row] = await db.update(ApiKeys).set({ name, updated_at: new Date() })
    .where(and(eq(ApiKeys.key_uuid, keyUuid), eq(ApiKeys.user_uuid, userUuid))).returning();
  if (!row) return GenResObj(Code.NOT_FOUND, false, "API key not found");
  return GenResObj(Code.OK, true, "API key renamed", publicKey(row));
};

export const revokeKey = async (userUuid: string, keyUuid: string) => {
  const [row] = await db.update(ApiKeys).set({ revoked_at: new Date(), updated_at: new Date() })
    .where(and(eq(ApiKeys.key_uuid, keyUuid), eq(ApiKeys.user_uuid, userUuid), isNull(ApiKeys.revoked_at))).returning();
  if (!row) return GenResObj(Code.NOT_FOUND, false, "API key not found or already revoked");
  return GenResObj(Code.OK, true, "API key revoked", publicKey(row));
};

/** Resolves a raw `ebma_sk_…` key to its owner, or a reason it cannot be used. */
export const resolveApiKey = async (rawKey: string) => {
  const [row] = await db.select().from(ApiKeys).where(eq(ApiKeys.key_hash, hashApiKey(rawKey))).limit(1);
  if (!row || row.revoked_at) return { ok: false as const, message: "API key is invalid or revoked" };
  if (row.expires_at && row.expires_at < new Date()) return { ok: false as const, message: "API key has expired" };
  void db.update(ApiKeys).set({ last_used_at: new Date() }).where(eq(ApiKeys.key_uuid, row.key_uuid))
    .catch((error) => console.error("Failed to record API key usage", error));
  return { ok: true as const, key: row };
};
