import { eq } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { UserLlmConfigs } from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";

const publicConfig = (row: typeof UserLlmConfigs.$inferSelect | undefined) => row ? ({ provider: row.provider, model: row.model_name, endpoint: row.endpoint, temperature: Number(row.temperature), maxTokens: row.max_tokens, topP: Number(row.top_p), timeoutMs: row.timeout_ms, hasApiKey: Boolean(row.api_key), updatedAt: row.updated_at }) : null;

export const getUserConfig = async (userUuid: string) => {
  const [row] = await db.select().from(UserLlmConfigs).where(eq(UserLlmConfigs.user_uuid, userUuid)).limit(1);
  return GenResObj(Code.OK, true, "LLM configuration fetched successfully", publicConfig(row));
};

export const saveUserConfig = async (userUuid: string, input: { provider: string; model: string; endpoint?: string; apiKey?: string; temperature?: number; maxTokens?: number; topP?: number; timeoutMs?: number }) => {
  if (!input.provider || !input.model) return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "Provider and model are required");
  const existing = await db.select({ api_key: UserLlmConfigs.api_key }).from(UserLlmConfigs).where(eq(UserLlmConfigs.user_uuid, userUuid)).limit(1);
  const apiKey = input.apiKey?.trim() || existing[0]?.api_key;
  const endpoint = input.endpoint?.trim() || null;
  if (input.provider.trim().toLowerCase() === "custom" && !endpoint) return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "A custom model endpoint is required");
  if (!apiKey && !endpoint) return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "Provide an API key or a custom model endpoint");
  const values = { user_uuid: userUuid, provider: input.provider.trim(), model_name: input.model.trim(), endpoint, api_key: apiKey || "", temperature: String(input.temperature ?? 0.7), max_tokens: Math.max(1, Math.floor(input.maxTokens ?? 1024)), top_p: String(input.topP ?? 1), timeout_ms: Math.max(1000, Math.floor(input.timeoutMs ?? 30000)), updated_at: new Date() };
  const [row] = existing.length
    ? await db.update(UserLlmConfigs).set(values).where(eq(UserLlmConfigs.user_uuid, userUuid)).returning()
    : await db.insert(UserLlmConfigs).values(values).returning();
  return GenResObj(Code.OK, true, "LLM configuration saved successfully", publicConfig(row));
};

export const loadPrivateUserConfig = async (userUuid: string) => {
  const [row] = await db.select().from(UserLlmConfigs).where(eq(UserLlmConfigs.user_uuid, userUuid)).limit(1);
  return row ?? null;
};
