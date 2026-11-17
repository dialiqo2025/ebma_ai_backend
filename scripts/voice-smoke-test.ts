/**
 * Smoke test: backend -> LiveKit -> EBMA voice agent, without the database or a portal login.
 * Builds the encrypted session payload exactly like voice.provider.createVoiceSession, dispatches
 * the agent, waits for it to join the room, checks its status attributes and cleans up.
 *
 *   npx tsx scripts/voice-smoke-test.ts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { encryptAgentMetadata, ownerTag } from "../src/services/voice/voice.crypto";
import { buildVoiceSystemPrompt, greetingFor } from "../src/services/voice/voice.helper";

const main = async () => {
  const apiUrl = process.env.LIVEKIT_URL!;
  const rooms = new RoomServiceClient(apiUrl, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);
  const dispatch = new AgentDispatchClient(apiUrl, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);
  const userUuid = "00000000-0000-4000-8000-00000000beef"; // synthetic, not a real account
  const sessionId = randomUUID();
  const roomName = `ebma-va-${sessionId}`;
  const identity = `user-${ownerTag(userUuid).slice(0, 16)}`;
  const input = { language: "en", replyLanguage: "auto" };
  const payload = {
    v: 1, exp: Math.floor(Date.now() / 1000) + 300, tenant_id: userUuid, user_id: userUuid,
    agent_id: "portal-voice-assistant", conversation_id: sessionId, room_name: roomName, user_identity: identity,
    system_prompt: buildVoiceSystemPrompt(input), greeting: greetingFor(input.language, input.replyLanguage),
    language: "en", stt_mode: "native", end_silence_ms: 600, voice_id: "seed:108", llm: { provider: "platform" },
  };
  const t0 = Date.now();
  await rooms.createRoom({ name: roomName, emptyTimeout: 60, departureTimeout: 10, maxParticipants: 2,
    metadata: JSON.stringify({ kind: "ebma-voice-assistant", owner: ownerTag(userUuid), session: sessionId }) });
  await dispatch.createDispatch(roomName, process.env.VOICE_AGENT_NAME || "ebma-voice-agent", {
    metadata: encryptAgentMetadata(payload, roomName),
  });
  // livekit-server-sdk reports attribute keys camel-cased ("ebma.voice" -> "ebmaVoice")
  const attr = (a: Record<string, string> | undefined, key: string) =>
    a?.[key] ?? a?.[key.replace(/[._]([a-z])/g, (_m, c: string) => c.toUpperCase())];
  let agent: { identity: string; attributes: Record<string, string> } | undefined;
  for (let i = 0; i < 40 && !attr(agent?.attributes, "ebma.voice"); i++) {
    await new Promise((r) => setTimeout(r, 500));
    agent = (await rooms.listParticipants(roomName)).find((p) => p.identity.startsWith("ebma-agent-"));
  }
  const report = {
    room: roomName,
    agentJoined: Boolean(agent),
    joinMs: agent ? Date.now() - t0 : null,
    agentState: attr(agent?.attributes, "lk.agent.state"),
    voiceStatus: attr(agent?.attributes, "ebma.voice"),
    llm: attr(agent?.attributes, "ebma.llm"),
  };
  await rooms.deleteRoom(roomName).catch(() => undefined);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.agentJoined && report.voiceStatus ? 0 : 1);
};

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
