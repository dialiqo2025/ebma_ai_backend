import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { and, desc, eq } from "drizzle-orm";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { db } from "../../config/database/connection.database";
import { TtsVoices } from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import { ensureWallet, recordUsage } from "../billing/billing.provider";
import { loadPrivateUserConfig } from "../llm/llm.user.provider";
import { getTtsVoicePreset, publicTtsVoicePresets } from "../tts/tts.voice-presets";
import { getTtsVoiceAudioPath, isTtsModelConfigured } from "../tts/tts.helper";
import { agentSharedSecret, encryptAgentMetadata, ownerTag, verifyAgentEventSignature } from "./voice.crypto";
import {
  buildVoiceSystemPrompt,
  greetingFor,
  PLATFORM_LLM_LABEL,
  resolveAgentLlm,
  VOICE_LANGUAGES,
} from "./voice.helper";
import type { CreateVoiceSession } from "./voice.validate";

const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const SESSION_TTL_SECONDS = 60 * 60;

const livekitConfig = () => {
  const apiUrl = process.env.LIVEKIT_URL?.trim() || "";
  const wsUrl = process.env.LIVEKIT_WS_URL?.trim() || apiUrl.replace(/^http/, "ws");
  const apiKey = process.env.LIVEKIT_API_KEY?.trim() || "";
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim() || "";
  const agentName = process.env.VOICE_AGENT_NAME?.trim() || "ebma-voice-agent";
  return { apiUrl, wsUrl, apiKey, apiSecret, agentName, ok: Boolean(apiUrl && apiKey && apiSecret && agentSharedSecret()) };
};

let clients: { rooms: RoomServiceClient; dispatch: AgentDispatchClient } | null = null;
const livekit = () => {
  const cfg = livekitConfig();
  if (!clients) {
    clients = {
      rooms: new RoomServiceClient(cfg.apiUrl, cfg.apiKey, cfg.apiSecret),
      dispatch: new AgentDispatchClient(cfg.apiUrl, cfg.apiKey, cfg.apiSecret),
    };
  }
  return clients;
};

export const getVoiceOptions = async (userUuid: string) => {
  const [llmRow, voices] = await Promise.all([
    loadPrivateUserConfig(userUuid),
    db
      .select({ voiceUuid: TtsVoices.voice_uuid, name: TtsVoices.name, language: TtsVoices.language })
      .from(TtsVoices)
      .where(eq(TtsVoices.user_uuid, userUuid))
      .orderBy(desc(TtsVoices.created_at)),
  ]);
  const llm = resolveAgentLlm(llmRow);
  return GenResObj(Code.OK, true, "Voice assistant options fetched successfully", {
    available: livekitConfig().ok && isTtsModelConfigured(),
    languages: VOICE_LANGUAGES,
    sttModes: ["native", "mixed", "romanized"],
    endSilenceMs: { min: 300, max: 2000, default: 600 },
    presets: publicTtsVoicePresets(),
    clonedVoices: voices,
    llm: llm.provider === "platform"
      ? { source: "platform", label: PLATFORM_LLM_LABEL() }
      : { source: "user", label: llm.label },
  });
};

const resolveVoice = async (userUuid: string, voice: CreateVoiceSession["voice"]) => {
  if (voice.type === "preset") {
    const preset = getTtsVoicePreset(voice.id);
    return { ok: true as const, voiceId: `seed:${preset.seed}`, label: preset.name };
  }
  const [row] = await db
    .select()
    .from(TtsVoices)
    .where(and(eq(TtsVoices.voice_uuid, voice.voiceUuid), eq(TtsVoices.user_uuid, userUuid)))
    .limit(1);
  if (!row) return { ok: false as const, response: GenResObj(Code.NOT_FOUND, false, "Voice not found") };
  const filePath = getTtsVoiceAudioPath(row.reference_audio_file_name);
  const info = await stat(filePath).catch(() => null);
  if (!info || info.size > MAX_REFERENCE_BYTES) {
    return { ok: false as const, response: GenResObj(Code.UNPROCESSABLE_ENTITY, false, "The voice sample is missing or larger than 8 MB") };
  }
  const sha256 = createHash("sha256").update(await readFile(filePath)).digest("hex");
  return {
    ok: true as const,
    // The browser uploads the sample to the agent over LiveKit; the agent only accepts
    // bytes whose SHA-256 matches this value (which the user cannot alter: it is encrypted).
    voiceId: `ref:${sha256}`,
    referenceText: row.reference_text ?? "",
    label: row.name,
    upload: { voiceUuid: row.voice_uuid, sha256, bytes: info.size },
  };
};

export const createVoiceSession = async (userUuid: string, input: CreateVoiceSession) => {
  const cfg = livekitConfig();
  if (!cfg.ok) {
    return GenResObj(Code.SERVICE_UNAVAILABLE, false, "The voice assistant is not configured on this server", { code: "voice_not_configured" });
  }

  const wallet = await ensureWallet(userUuid);
  if (!wallet || Number(wallet.balance_credits) <= 0) {
    return GenResObj(Code.PAYMENT_REQUIRED, false, "Your credits are exhausted. Recharge your wallet to use the voice assistant.", { code: "insufficient_credits" });
  }

  const voice = await resolveVoice(userUuid, input.voice);
  if (!voice.ok) return voice.response;

  const llm = resolveAgentLlm(await loadPrivateUserConfig(userUuid));
  const sessionId = randomUUID();
  const roomName = `ebma-va-${sessionId}`;
  const owner = ownerTag(userUuid);
  const identity = `user-${owner.slice(0, 16)}`;
  const greeting = input.greeting === undefined ? greetingFor(input.language, input.replyLanguage) : input.greeting;

  const agentPayload = {
    v: 1,
    exp: Math.floor(Date.now() / 1000) + 300,
    tenant_id: userUuid,
    user_id: userUuid,
    agent_id: "portal-voice-assistant",
    conversation_id: sessionId,
    room_name: roomName,
    user_identity: identity,
    system_prompt: buildVoiceSystemPrompt(input),
    greeting,
    language: input.language,
    stt_mode: input.sttMode,
    end_silence_ms: input.endSilenceMs,
    voice_id: voice.voiceId,
    ...("referenceText" in voice ? { voice_reference_text: voice.referenceText } : {}),
    llm,
  };

  const { rooms, dispatch } = livekit();
  try {
    await rooms.createRoom({
      name: roomName,
      emptyTimeout: 60,
      departureTimeout: 10,
      maxParticipants: 2,
      metadata: JSON.stringify({ kind: "ebma-voice-assistant", owner, session: sessionId }),
    });
    await dispatch.createDispatch(roomName, cfg.agentName, { metadata: encryptAgentMetadata(agentPayload, roomName) });
  } catch (error) {
    console.error("Voice session start failed", error instanceof Error ? error.message : error);
    await rooms.deleteRoom(roomName).catch(() => undefined);
    return GenResObj(Code.SERVICE_UNAVAILABLE, false, "The voice assistant is temporarily unavailable. Please try again.", { code: "voice_unavailable" });
  }

  const at = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity, name: "You", ttl: SESSION_TTL_SECONDS });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: false });

  return GenResObj(Code.CREATED, true, "Voice session started", {
    sessionId,
    roomName,
    livekitUrl: cfg.wsUrl,
    token: await at.toJwt(),
    identity,
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
    voice: { label: voice.label, ...("upload" in voice ? { upload: voice.upload } : {}) },
    llm: llm.provider === "platform" ? { source: "platform", label: PLATFORM_LLM_LABEL() } : { source: "user", label: llm.label },
  });
};

export const endVoiceSession = async (userUuid: string, roomName: string) => {
  if (!livekitConfig().ok) return GenResObj(Code.OK, true, "Voice session ended");
  const { rooms } = livekit();
  const [room] = await rooms.listRooms([roomName]).catch(() => []);
  if (!room) return GenResObj(Code.OK, true, "Voice session already ended");
  let owner = "";
  try {
    owner = JSON.parse(room.metadata || "{}").owner ?? "";
  } catch {
    /* not one of ours */
  }
  if (owner !== ownerTag(userUuid)) return GenResObj(Code.NOT_FOUND, false, "Voice session not found");
  await rooms.deleteRoom(roomName);
  return GenResObj(Code.OK, true, "Voice session ended");
};

/**
 * Session lifecycle events POSTed (HMAC-signed) by the voice agent.
 * session.ended carries the usage summary that is billed here.
 */
export const handleAgentEvent = async (rawBody: Buffer, timestamp?: string, signature?: string) => {
  if (!verifyAgentEventSignature(rawBody, timestamp, signature)) {
    return GenResObj(Code.UNAUTHORIZED, false, "Invalid signature");
  }
  let event: any;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return GenResObj(Code.BAD_REQUEST, false, "Invalid JSON");
  }
  if (event?.event !== "session.ended" || event?.agent_id !== "portal-voice-assistant") {
    return GenResObj(Code.OK, true, "Event ignored");
  }
  const userUuid = String(event.user_id || "");
  const sessionId = String(event.conversation_id || "");
  if (!/^[0-9a-f-]{36}$/i.test(userUuid) || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return GenResObj(Code.BAD_REQUEST, false, "Invalid session identifiers");
  }
  const data = event.data ?? {};
  const metadata = { source: "voice_assistant", sessionId, durationS: data.duration_s, endReason: data.end_reason };
  const usage: Array<{ type: "stt_seconds" | "tts_characters" | "llm_tokens"; quantity: number }> = [
    { type: "stt_seconds", quantity: Math.ceil(Number(data.stt_audio_s) || 0) },
    { type: "tts_characters", quantity: Math.floor(Number(data.tts_characters) || 0) },
    { type: "llm_tokens", quantity: Math.floor((Number(data.llm_input_tokens) || 0) + (Number(data.llm_output_tokens) || 0)) },
  ];
  for (const item of usage) {
    if (item.quantity <= 0) continue;
    await recordUsage({
      userUuid,
      type: item.type,
      quantity: item.quantity,
      // one charge per session and usage type, even if the agent retries the webhook
      idempotencyKey: `voice:${sessionId}:${item.type}`,
      providerReference: sessionId,
      metadata,
    });
  }
  return GenResObj(Code.OK, true, "Usage recorded");
};
