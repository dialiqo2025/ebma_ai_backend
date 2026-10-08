import { EventEmitter } from "events";
import WebSocket from "ws";
import { vlog } from "./voice-log";

export type AsrFinal = { text: string; lang?: string; latency_ms?: number; audio_s?: number };

export type AsrClientEvents = {
  ready: [];
  speaking: [boolean];
  partial: [string];
  final: [AsrFinal];
  error: [Error];
  closed: [];
};

/**
 * Server-side EBMA ASR stream (see docs/ebma-asr/docs/api-reference.md §3).
 * Servers authenticate with the API key in the Authorization header, so no token round trip.
 */
export class AsrClient extends EventEmitter<AsrClientEvents> {
  private socket: WebSocket | null = null;
  private ready = false;
  private pending: Buffer[] = [];
  private closed = false;
  audioSeconds = 0;

  constructor(private readonly options: {
    sampleRate: number;
    language: string;
    mode: string;
    endSilenceMs: number;
  }) {
    super();
  }

  connect() {
    const baseUrl = process.env.EBMA_ASR_BACKEND_URL?.trim().replace(/\/+$/, "");
    const apiKey = process.env.EBMA_ASR_API_KEY?.trim();
    if (!baseUrl || !apiKey) {
      queueMicrotask(() => this.emit("error", new Error("EBMA ASR backend is not configured")));
      return;
    }
    const wsUrl = process.env.EBMA_ASR_WS_URL?.trim() || `${baseUrl.replace(/^http/, "ws")}/ws`;
    vlog.info("asr", "connecting", { url: wsUrl, sample_rate: this.options.sampleRate, lang: this.options.language, mode: this.options.mode });
    const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    this.socket = socket;

    socket.on("unexpected-response", (_req, res) => {
      vlog.error("asr", "connection rejected", { status: res.statusCode });
    });

    socket.on("open", () => {
      vlog.info("asr", "socket open; sending start");
      socket.send(JSON.stringify({
        type: "start",
        sample_rate: this.options.sampleRate,
        lang: this.options.language,
        mode: this.options.mode,
        end_silence_ms: this.options.endSilenceMs,
        partials: true,
      }));
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      let event: any;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (event?.type) {
        case "ready":
          this.ready = true;
          for (const frame of this.pending) socket.send(frame);
          this.pending = [];
          this.emit("ready");
          break;
        case "vad":
          this.emit("speaking", Boolean(event.speaking));
          break;
        case "partial":
          if (event.text) this.emit("partial", String(event.text));
          break;
        case "final":
          if (typeof event.audio_s === "number") this.audioSeconds += event.audio_s;
          if (event.text) this.emit("final", { text: String(event.text), lang: event.lang, latency_ms: event.latency_ms, audio_s: event.audio_s });
          break;
        case "error":
          vlog.warn("asr", "server error message", { code: event.code, message: event.message });
          // bad_request keeps the session open; anything else is followed by a close.
          if (event.code !== "bad_request") this.emit("error", new Error(`ASR ${event.code}: ${event.message}`));
          break;
        default:
          break;
      }
    });

    socket.on("error", (error) => this.emit("error", error));
    socket.on("close", (code, reason) => {
      vlog.info("asr", "socket closed", { code, reason: reason.toString(), audio_s: this.audioSeconds });
      this.closed = true;
      this.emit("closed");
    });
  }

  /** Send caller audio; buffered until the ASR server says `ready` so the first words are kept. */
  sendAudio(frame: Buffer) {
    if (this.closed || !this.socket) return;
    if (frame.length % 2 !== 0) frame = frame.subarray(0, frame.length - 1);
    if (!this.ready) {
      if (this.pending.length < 500) this.pending.push(frame);
      return;
    }
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(frame);
  }

  close() {
    if (!this.socket || this.closed) return;
    try {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "stop" }));
    } catch {
      // ignore
    }
    const socket = this.socket;
    setTimeout(() => socket.terminate(), 2000).unref();
  }
}
