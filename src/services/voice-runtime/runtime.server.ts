import type http from "http";
import jwt from "jsonwebtoken";
import { and, eq } from "drizzle-orm";
import WebSocket, { WebSocketServer } from "ws";
import { db } from "../../config/database/connection.database";
import { VoiceBots, type VoiceBotConnections } from "../../schema";
import { resolveConnectionToken } from "../voice-bot/voice-bot.provider";
import { ipAllowed } from "./audio.util";
import { CallSession, type CallControl, type VoiceTransport } from "./call-session";
import { errorText, maskSecret, vlog } from "./voice-log";

/**
 * Real-time voice endpoints, attached to the main HTTP server:
 *
 *   /voice/v1/stream?bot=<bot_uuid>&token=<connection token>
 *     Call center media stream (FreeSWITCH mod_audio_stream). The first text frame is the
 *     call metadata JSON; after that, binary L16 mono frames at the connection's sample rate.
 *
 *   /voice/v1/test?bot=<bot_uuid>&access_token=<portal JWT>
 *     Browser test client: 16 kHz L16 in, 16 kHz L16 out, JSON events for transcript/clear/transfer.
 */

const STREAM_PATH = "/voice/v1/stream";
const TEST_PATH = "/voice/v1/test";
const METADATA_WAIT_MS = 3000;

type Connection = typeof VoiceBotConnections.$inferSelect;

const clientIp = (req: http.IncomingMessage) => {
  const forwarded = process.env.VOICE_TRUST_PROXY === "true"
    ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim()
    : "";
  return forwarded || req.socket.remoteAddress || "";
};

const loadBot = async (userUuid: string, botUuid: string | null) => {
  if (!botUuid || !/^[0-9a-f-]{36}$/i.test(botUuid)) return null;
  const [bot] = await db.select().from(VoiceBots)
    .where(and(eq(VoiceBots.bot_uuid, botUuid), eq(VoiceBots.user_uuid, userUuid)))
    .limit(1);
  return bot?.enabled ? bot : null;
};

/** A complete HTTP response, so proxies (cloudflared, nginx) relay the status instead of a 500/502. */
const reject = (socket: import("stream").Duplex, status: number, message: string, reason: string, info: Record<string, unknown> = {}) => {
  vlog.warn("upgrade", `rejected ${status}`, { reason, ...info });
  const body = `${status} ${message}: ${reason}\n`;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};

/** Talkify-style control API: POST {callback_url}/handoff | /hangup | /break. */
const callbackControl = (connection: Connection, externalCallId: string | null): CallControl => {
  const post = async (action: string, body: Record<string, unknown>) => {
    if (!connection.callback_url) {
      vlog.error("callback", `${action} skipped: no callback URL configured on the connection`, { call_id: externalCallId });
      throw new Error("No callback URL configured on this connection");
    }
    const url = `${connection.callback_url.replace(/\/+$/, "")}/${action}`;
    const startedAt = Date.now();
    vlog.info("callback", `${action} ->`, { url, call_id: externalCallId, has_token: Boolean(connection.callback_token) });
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(connection.callback_token ? { Authorization: `Bearer ${connection.callback_token}` } : {}),
        },
        body: JSON.stringify({ call_id: externalCallId, ...body }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (error) {
      vlog.error("callback", `${action} failed (network)`, { url, ms: Date.now() - startedAt, error: errorText(error) });
      throw error;
    }
    const text = (await response.text()).slice(0, 300);
    vlog.info("callback", `${action} <- HTTP ${response.status}`, { ms: Date.now() - startedAt, body: text });
    if (!response.ok) throw new Error(`${action} callback returned HTTP ${response.status}: ${text}`);
  };
  return {
    handoff: (payload) => post("handoff", { conversation_id: payload.conversationId, summary: payload.summary, reason: payload.reason }),
    hangup: (payload) => post("hangup", { conversation_id: payload.conversationId, summary: payload.summary, reason: payload.reason }),
    breakPlayback: () => post("break", {}),
  };
};

const socketTransport = (ws: WebSocket, sampleRate: number, playbackMode: "json" | "binary", uiEvents = false): VoiceTransport => ({
  sampleRate,
  playbackMode,
  uiEvents,
  sendJson: (message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  },
  sendBinary: (frame) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true });
  },
  close: () => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, "done");
  },
});

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Wire a socket to a session: wait for the metadata frame, then forward audio. */
const runSession = (
  ws: WebSocket,
  label: string,
  createSession: (metadata: Record<string, unknown>) => Promise<CallSession>,
) => {
  let session: CallSession | null = null;
  let starting: Promise<void> | null = null;
  const early: Buffer[] = [];
  const openedAt = Date.now();
  let frames = 0;
  let bytes = 0;
  let textFrames = 0;

  const begin = (metadata: Record<string, unknown>, source: string) => {
    if (starting) return;
    vlog.info(label, "starting session", { metadata_source: source, metadata });
    starting = createSession(metadata)
      .then(async (created) => {
        session = created;
        await created.start();
        vlog.info(label, "session started", { conversation_id: created.conversationId, buffered_frames: early.length });
        for (const frame of early.splice(0)) created.onCallerAudio(frame);
      })
      .catch((error) => {
        vlog.error(label, "session failed to start", { error: errorText(error) });
        console.error(error);
        ws.close(1011, "session start failed");
      });
  };

  const timer = setTimeout(() => {
    vlog.warn(label, `no metadata frame within ${METADATA_WAIT_MS} ms; starting without it`);
    begin({}, "timeout");
  }, METADATA_WAIT_MS);

  // Periodic audio counter (debug) so a silent stream is visible in the logs.
  const stats = setInterval(() => {
    vlog.debug(label, "audio in", { frames, bytes, seconds: Math.round((Date.now() - openedAt) / 1000) });
  }, 10_000);

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (frames === 0) vlog.info(label, "first audio frame", { bytes: frame.length, ms_after_open: Date.now() - openedAt });
      frames++;
      bytes += frame.length;
      if (session) session.onCallerAudio(frame);
      else if (early.length < 300) early.push(frame);
      return;
    }
    textFrames++;
    const text = data.toString();
    vlog.info(label, "text frame", { n: textFrames, text: text.slice(0, 500) });
    if (starting) return; // later text frames are not used
    clearTimeout(timer);
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") metadata = parsed;
    } catch {
      vlog.warn(label, "first text frame is not JSON; starting without metadata");
    }
    begin(metadata, "text frame");
  });

  ws.on("close", (code, reason) => {
    clearTimeout(timer);
    clearInterval(stats);
    vlog.info(label, "socket closed", {
      code,
      reason: reason.toString(),
      seconds: Math.round((Date.now() - openedAt) / 1000),
      audio_frames: frames,
      audio_bytes: bytes,
      text_frames: textFrames,
      conversation_id: session?.conversationId ?? null,
    });
    void (starting ?? Promise.resolve()).then(() => session?.finalize());
  });
  ws.on("error", (error) => vlog.error(label, "socket error", { error: error.message }));
};

type VoiceBot = NonNullable<Awaited<ReturnType<typeof loadBot>>>;

/* Short-lived caches so repeat calls do not wait on the database before streaming. */
const AUTH_CACHE_MS = 30_000;
const connectionCache = new Map<string, { at: number; value: Connection | null }>();
const botCache = new Map<string, { at: number; value: VoiceBot | null }>();

const cachedConnection = async (token: string) => {
  const hit = connectionCache.get(token);
  if (hit && Date.now() - hit.at < AUTH_CACHE_MS) return hit.value;
  const value = await resolveConnectionToken(token);
  connectionCache.set(token, { at: Date.now(), value });
  return value;
};

const cachedBot = async (userUuid: string, botUuid: string | null) => {
  const key = `${userUuid}:${botUuid}`;
  const hit = botCache.get(key);
  if (hit && Date.now() - hit.at < AUTH_CACHE_MS) return hit.value;
  const value = await loadBot(userUuid, botUuid);
  botCache.set(key, { at: Date.now(), value });
  return value;
};

/** Call-center stream, after the connection token and bot have been authorized. */
const startStream = (ws: WebSocket, url: URL, connection: Connection, bot: VoiceBot) => {
  const playbackMode = connection.playback_mode === "binary" ? "binary" : "json";
  const sampleRate = Number(url.searchParams.get("rate")) || connection.sample_rate;
  const label = `stream ${bot.name}`;
  vlog.info(label, "authorized", {
    connection: connection.connection_uuid,
    bot: bot.bot_uuid,
    sample_rate: sampleRate,
    playback_mode: playbackMode,
    callback_url: connection.callback_url,
  });
  runSession(ws, label, async (metadata) => {
    const externalCallId = str(metadata.call_uuid) ?? str(url.searchParams.get("call"));
    if (!externalCallId) vlog.warn(label, "no call_uuid in metadata; handoff/hangup callbacks cannot target the call");
    return new CallSession(bot, socketTransport(ws, sampleRate, playbackMode), callbackControl(connection, externalCallId), {
      userUuid: connection.user_uuid,
      connectionUuid: connection.connection_uuid,
      externalCallId,
      caller: str(metadata.caller),
      callee: str(metadata.did),
      metadata,
    });
  });
};

export const attachVoiceRuntime = (server: http.Server) => {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const ip = clientIp(req);
    vlog.info("upgrade", "request", {
      path: url.pathname,
      ip,
      socket_ip: req.socket.remoteAddress,
      x_forwarded_for: req.headers["x-forwarded-for"] ?? null,
      cf_connecting_ip: req.headers["cf-connecting-ip"] ?? null,
      user_agent: req.headers["user-agent"] ?? null,
      bot: url.searchParams.get("bot"),
      token: maskSecret(url.searchParams.get("token")),
      rate: url.searchParams.get("rate"),
      has_access_token: url.searchParams.has("access_token"),
    });
    if (url.pathname !== STREAM_PATH && url.pathname !== TEST_PATH) {
      vlog.warn("upgrade", "unknown WebSocket path; not handled by the voice runtime", { path: url.pathname });
      return;
    }

    void (async () => {
      try {
        if (url.pathname === STREAM_PATH) {
          const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
          const token = url.searchParams.get("token") || bearer;
          if (!token) return reject(socket, 401, "Unauthorized", "no connection token in ?token= or Authorization header");

          // mod_audio_stream (libwsc) aborts if the 101 takes longer than 1 s, which a tunnel plus two remote
          // DB queries easily exceeds. So complete the upgrade first, then authorize; frames that arrive
          // meanwhile (the metadata frame, early audio) are buffered and replayed.
          wss.handleUpgrade(req, socket, head, (ws) => {
            vlog.info("upgrade", "101 sent; authorizing", { token: maskSecret(token), bot: url.searchParams.get("bot") });
            const pending: Array<[WebSocket.RawData, boolean]> = [];
            const buffer = (data: WebSocket.RawData, isBinary: boolean) => {
              if (pending.length < 500) pending.push([data, isBinary]);
            };
            ws.on("message", buffer);

            void (async () => {
              const deny = (code: number, reason: string, info: Record<string, unknown> = {}) => {
                vlog.warn("upgrade", `closing ${code}`, { reason, ...info });
                ws.close(code, reason.slice(0, 120));
              };
              let connection: Connection | null;
              let bot: Awaited<ReturnType<typeof loadBot>>;
              try {
                connection = await cachedConnection(token);
                if (!connection) return deny(4401, "connection token not found or revoked", { token: maskSecret(token) });
                if (!ipAllowed(ip, connection.allowed_ips)) {
                  return deny(4403, "client IP is not in the connection's allowed IPs", { ip, allowed_ips: connection.allowed_ips });
                }
                bot = await cachedBot(connection.user_uuid, url.searchParams.get("bot"));
                if (!bot) return deny(4404, "bot not found, not owned by this account, or disabled", { bot: url.searchParams.get("bot") });
              } catch (error) {
                return deny(1011, `authorization failed: ${errorText(error)}`);
              }
              const authorized = connection;
              const authorizedBot = bot;
              if (ws.readyState !== WebSocket.OPEN) {
                vlog.warn("upgrade", "client closed before authorization finished");
                return;
              }
              ws.off("message", buffer);
              startStream(ws, url, authorized, authorizedBot);
              for (const [data, isBinary] of pending.splice(0)) ws.emit("message", data, isBinary);
            })();
          });
          return;
        }

        // Browser test client, authenticated with the portal session JWT.
        let userUuid: string;
        try {
          const decoded = jwt.verify(url.searchParams.get("access_token") ?? "", process.env.JWT_SECRET_KEY!) as { id?: string };
          if (!decoded?.id) throw new Error("no subject");
          userUuid = decoded.id;
        } catch (error) {
          return reject(socket, 401, "Unauthorized", `invalid portal session: ${errorText(error)}`);
        }
        const bot = await loadBot(userUuid, url.searchParams.get("bot"));
        if (!bot) return reject(socket, 404, "Bot Not Found", "bot not found for this user or disabled", { bot: url.searchParams.get("bot") });

        wss.handleUpgrade(req, socket, head, (ws) => {
          vlog.info(`test ${bot.name}`, "upgrade accepted", { bot: bot.bot_uuid });
          const transport = socketTransport(ws, 16_000, "binary", true);
          const browserControl: CallControl = {
            handoff: async (payload) => transport.sendJson({ type: "transfer", ...payload }),
            hangup: async (payload) => transport.sendJson({ type: "hangup", ...payload }),
            breakPlayback: async () => undefined,
          };
          runSession(ws, `test ${bot.name}`, async (metadata) => new CallSession(bot, transport, browserControl, {
            userUuid,
            connectionUuid: null,
            externalCallId: null,
            caller: "browser-test",
            callee: null,
            metadata: { ...metadata, source: "browser-test" },
          }));
        });
      } catch (error) {
        console.error(error);
        reject(socket, 500, "Internal Server Error", `upgrade handler crashed: ${errorText(error)}`);
      }
    })();
  });

  vlog.info("runtime", `listening on ${STREAM_PATH} and ${TEST_PATH}`, {
    log_level: process.env.VOICE_LOG_LEVEL || "info",
    trust_proxy: process.env.VOICE_TRUST_PROXY === "true",
  });
};
