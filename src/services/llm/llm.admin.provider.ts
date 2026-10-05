import { desc, eq } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { LlmModelConfigs } from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";

const safeModel = (row: typeof LlmModelConfigs.$inferSelect) => ({ ...row, api_key: undefined, hasApiKey: Boolean(row.api_key) });

export const listModels = async () => GenResObj(Code.OK, true, "LLM models fetched successfully", (await db.select().from(LlmModelConfigs).orderBy(desc(LlmModelConfigs.created_at))).map(safeModel));

export const createModel = async (input: { provider: string; modelName: string; displayName: string; endpoint?: string; apiKey?: string; temperature?: number; maxTokens?: number; timeoutMs?: number; active?: boolean; isDefault?: boolean }) => {
  if (input.isDefault) await db.update(LlmModelConfigs).set({ is_default: false, updated_at: new Date() });
  const [row] = await db.insert(LlmModelConfigs).values({ provider: input.provider, model_name: input.modelName, display_name: input.displayName, endpoint: input.endpoint || null, api_key: input.apiKey || null, temperature: String(input.temperature ?? 0.7), max_tokens: input.maxTokens ?? 1024, timeout_ms: input.timeoutMs ?? 30000, active: input.active ?? true, is_default: input.isDefault ?? false }).returning();
  return GenResObj(Code.CREATED, true, "LLM model created successfully", row ? safeModel(row) : undefined);
};

export const updateModel = async (uuid: string, input: Partial<{ provider: string; modelName: string; displayName: string; endpoint: string; apiKey: string; temperature: number; maxTokens: number; timeoutMs: number; active: boolean; isDefault: boolean }>) => {
  if (input.isDefault) await db.update(LlmModelConfigs).set({ is_default: false, updated_at: new Date() });
  const [row] = await db.update(LlmModelConfigs).set({ ...(input.provider !== undefined ? { provider: input.provider } : {}), ...(input.modelName !== undefined ? { model_name: input.modelName } : {}), ...(input.displayName !== undefined ? { display_name: input.displayName } : {}), ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}), ...(input.apiKey !== undefined ? { api_key: input.apiKey } : {}), ...(input.temperature !== undefined ? { temperature: String(input.temperature) } : {}), ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}), ...(input.timeoutMs !== undefined ? { timeout_ms: input.timeoutMs } : {}), ...(input.active !== undefined ? { active: input.active } : {}), ...(input.isDefault !== undefined ? { is_default: input.isDefault } : {}), updated_at: new Date() }).where(eq(LlmModelConfigs.model_uuid, uuid)).returning();
  return row ? GenResObj(Code.OK, true, "LLM model updated successfully", safeModel(row)) : GenResObj(Code.NOT_FOUND, false, "LLM model not found");
};

export const deleteModel = async (uuid: string) => { const [row] = await db.delete(LlmModelConfigs).where(eq(LlmModelConfigs.model_uuid, uuid)).returning({ id: LlmModelConfigs.model_uuid }); return row ? GenResObj(Code.OK, true, "LLM model deleted successfully") : GenResObj(Code.NOT_FOUND, false, "LLM model not found"); };
