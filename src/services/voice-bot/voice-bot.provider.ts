import crypto from "crypto";
import { and, asc, count, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { VoiceBotConnections, VoiceBots, VoiceCalls, VoiceCallTurns } from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import type { CreateConnection, CreateVoiceBot, UpdateConnection, UpdateVoiceBot } from "./voice-bot.validate";

export const CONNECTION_TOKEN_PREFIX = "ebma_vc_";

export const hashConnectionToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const stripUndefined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

// ---------------------------------------------------------------- bots

export const listBots = async (userUuid: string) => {
  const rows = await db.select().from(VoiceBots).where(eq(VoiceBots.user_uuid, userUuid)).orderBy(desc(VoiceBots.created_at));
  return GenResObj(Code.OK, true, "Voice bots fetched successfully", rows);
};

export const getBot = async (userUuid: string, botUuid: string) => {
  const [row] = await db.select().from(VoiceBots).where(and(eq(VoiceBots.user_uuid, userUuid), eq(VoiceBots.bot_uuid, botUuid))).limit(1);
  if (!row) return GenResObj(Code.NOT_FOUND, false, "Voice bot not found");
  return GenResObj(Code.OK, true, "Voice bot fetched successfully", row);
};

export const createBot = async (userUuid: string, input: CreateVoiceBot) => {
  const [row] = await db.insert(VoiceBots).values({ ...input, voice_id: input.voice_id ?? null, user_uuid: userUuid }).returning();
  return GenResObj(Code.CREATED, true, "Voice bot created successfully", row);
};

export const updateBot = async (userUuid: string, botUuid: string, input: UpdateVoiceBot) => {
  const [row] = await db.update(VoiceBots)
    .set({ ...stripUndefined(input), updated_at: new Date() })
    .where(and(eq(VoiceBots.user_uuid, userUuid), eq(VoiceBots.bot_uuid, botUuid)))
    .returning();
  if (!row) return GenResObj(Code.NOT_FOUND, false, "Voice bot not found");
  return GenResObj(Code.OK, true, "Voice bot updated successfully", row);
};

export const deleteBot = async (userUuid: string, botUuid: string) => {
  const [row] = await db.delete(VoiceBots)
    .where(and(eq(VoiceBots.user_uuid, userUuid), eq(VoiceBots.bot_uuid, botUuid)))
    .returning({ bot_uuid: VoiceBots.bot_uuid });
  if (!row) return GenResObj(Code.NOT_FOUND, false, "Voice bot not found");
  return GenResObj(Code.OK, true, "Voice bot deleted successfully", row);
};

// ---------------------------------------------------------------- connections

const publicConnection = (row: typeof VoiceBotConnections.$inferSelect) => ({
  connection_uuid: row.connection_uuid,
  name: row.name,
  token_prefix: row.token_prefix,
  allowed_ips: row.allowed_ips,
  callback_url: row.callback_url,
  has_callback_token: Boolean(row.callback_token),
  playback_mode: row.playback_mode,
  sample_rate: row.sample_rate,
  revoked_at: row.revoked_at,
  last_used_at: row.last_used_at,
  created_at: row.created_at,
});

export const listConnections = async (userUuid: string) => {
  const rows = await db.select().from(VoiceBotConnections)
    .where(eq(VoiceBotConnections.user_uuid, userUuid))
    .orderBy(desc(VoiceBotConnections.created_at));
  return GenResObj(Code.OK, true, "Connections fetched successfully", rows.map(publicConnection));
};

export const createConnection = async (userUuid: string, input: CreateConnection) => {
  const token = `${CONNECTION_TOKEN_PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
  const [row] = await db.insert(VoiceBotConnections).values({
    user_uuid: userUuid,
    name: input.name,
    allowed_ips: input.allowed_ips,
    callback_url: input.callback_url ?? null,
    callback_token: input.callback_token ?? null,
    playback_mode: input.playback_mode,
    sample_rate: input.sample_rate,
    token_prefix: `${token.slice(0, CONNECTION_TOKEN_PREFIX.length + 6)}…`,
    token_hash: hashConnectionToken(token),
  }).returning();
  // The plain token is only ever returned here.
  return GenResObj(Code.CREATED, true, "Connection created. Copy the token now; it is not shown again.", { ...publicConnection(row!), token });
};

export const updateConnection = async (userUuid: string, connectionUuid: string, input: UpdateConnection) => {
  const [row] = await db.update(VoiceBotConnections)
    .set({ ...stripUndefined(input), updated_at: new Date() })
    .where(and(eq(VoiceBotConnections.user_uuid, userUuid), eq(VoiceBotConnections.connection_uuid, connectionUuid)))
    .returning();
  if (!row) return GenResObj(Code.NOT_FOUND, false, "Connection not found");
  return GenResObj(Code.OK, true, "Connection updated successfully", publicConnection(row));
};

export const revokeConnection = async (userUuid: string, connectionUuid: string) => {
  const [row] = await db.update(VoiceBotConnections)
    .set({ revoked_at: new Date(), updated_at: new Date() })
    .where(and(
      eq(VoiceBotConnections.user_uuid, userUuid),
      eq(VoiceBotConnections.connection_uuid, connectionUuid),
      isNull(VoiceBotConnections.revoked_at),
    ))
    .returning();
  if (!row) return GenResObj(Code.NOT_FOUND, false, "Connection not found or already revoked");
  return GenResObj(Code.OK, true, "Connection revoked successfully", publicConnection(row));
};

/** Used by the runtime: resolve a raw connection token to its active row. */
export const resolveConnectionToken = async (token: string) => {
  if (!token.startsWith(CONNECTION_TOKEN_PREFIX)) return null;
  const [row] = await db.select().from(VoiceBotConnections)
    .where(and(eq(VoiceBotConnections.token_hash, hashConnectionToken(token)), isNull(VoiceBotConnections.revoked_at)))
    .limit(1);
  if (!row) return null;
  // Drizzle builders only run when awaited/then-ed; do not block the upgrade on it.
  db.update(VoiceBotConnections).set({ last_used_at: new Date() }).where(eq(VoiceBotConnections.connection_uuid, row.connection_uuid))
    .then(() => undefined, (error) => console.error("Could not update connection last_used_at:", error));
  return row;
};

// ---------------------------------------------------------------- calls

export const listCalls = async (userUuid: string, query: { page: number; limit: number; bot_uuid?: string | undefined }) => {
  const where = query.bot_uuid
    ? and(eq(VoiceCalls.user_uuid, userUuid), eq(VoiceCalls.bot_uuid, query.bot_uuid))
    : eq(VoiceCalls.user_uuid, userUuid);
  const [rows, [total]] = await Promise.all([
    db.select({
      call_uuid: VoiceCalls.call_uuid,
      bot_uuid: VoiceCalls.bot_uuid,
      bot_name: VoiceBots.name,
      external_call_id: VoiceCalls.external_call_id,
      caller: VoiceCalls.caller,
      callee: VoiceCalls.callee,
      status: VoiceCalls.status,
      end_reason: VoiceCalls.end_reason,
      summary: VoiceCalls.summary,
      handoff_target: VoiceCalls.handoff_target,
      duration_seconds: VoiceCalls.duration_seconds,
      started_at: VoiceCalls.started_at,
      ended_at: VoiceCalls.ended_at,
    })
      .from(VoiceCalls)
      .leftJoin(VoiceBots, eq(VoiceBots.bot_uuid, VoiceCalls.bot_uuid))
      .where(where)
      .orderBy(desc(VoiceCalls.started_at))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit),
    db.select({ value: count() }).from(VoiceCalls).where(where),
  ]);
  return GenResObj(Code.OK, true, "Voice calls fetched successfully", { rows, total: total?.value ?? 0, page: query.page, limit: query.limit });
};

/** Look a call up by our call uuid or by the call center's call id. */
export const getCall = async (userUuid: string, id: string) => {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const [call] = await db.select({
    call: VoiceCalls,
    bot_name: VoiceBots.name,
  })
    .from(VoiceCalls)
    .leftJoin(VoiceBots, eq(VoiceBots.bot_uuid, VoiceCalls.bot_uuid))
    .where(and(
      eq(VoiceCalls.user_uuid, userUuid),
      isUuid ? or(eq(VoiceCalls.call_uuid, id), eq(VoiceCalls.external_call_id, id)) : eq(VoiceCalls.external_call_id, id),
    ))
    .orderBy(desc(VoiceCalls.started_at))
    .limit(1);
  if (!call) return GenResObj(Code.NOT_FOUND, false, "Voice call not found");

  const turns = await db.select({
    role: VoiceCallTurns.role,
    text: VoiceCallTurns.text,
    interrupted: VoiceCallTurns.interrupted,
    latency_ms: VoiceCallTurns.latency_ms,
    created_at: VoiceCallTurns.created_at,
  })
    .from(VoiceCallTurns)
    .where(eq(VoiceCallTurns.call_uuid, call.call.call_uuid))
    .orderBy(asc(VoiceCallTurns.turn_index));

  return GenResObj(Code.OK, true, "Voice call fetched successfully", { ...call.call, bot_name: call.bot_name, turns });
};
