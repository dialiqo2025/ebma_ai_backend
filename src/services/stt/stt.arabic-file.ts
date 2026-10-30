/**
 * Arabic file transcription over /ar/ws (server-side).
 * URL from EBMA_ASR_ARABIC_WS_URL; auth via EBMA_ASR_API_KEY as ?key=.
 * Never expose that URL+key to the browser.
 */
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { buildArabicFileWsUrl } from "./stt.arabic";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const CHUNK_MS = 100;
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000;

const mergeStreamingText = (previous: string, incoming: string) => {
  const prev = previous.trim();
  const next = incoming.trim();
  if (!next) return prev;
  if (!prev) return next;
  if (next === prev) return prev;
  if (next.startsWith(prev)) return next;
  if (prev.startsWith(next) && next.length >= Math.min(8, prev.length)) return next;
  if (prev.endsWith(next)) return prev;
  return `${prev} ${next}`;
};

export const isArabicWsJobId = (jobId: string) => jobId.startsWith("arabic-ws:");

export { buildArabicFileWsUrl };

/** Decode any ffmpeg-supported audio/video to mono s16le PCM @ 16 kHz. */
export const decodeAudioToPcm16kMono = (file: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ac",
        "1",
        "-ar",
        String(SAMPLE_RATE),
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const chunks: Buffer[] = [];
    let stderr = "";

    ff.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ff.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    ff.on("error", (err) =>
      reject(new Error(`ffmpeg is unavailable: ${err.message}`)),
    );
    ff.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
              "Failed to decode audio for Arabic transcription (ffmpeg)",
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    ff.stdin.write(file);
    ff.stdin.end();
  });

export type ArabicFileTranscriptionResult = {
  transcript: string;
  segments: Array<{ start: number; end: number; text: string }>;
  audioSeconds: number;
};

/**
 * Stream PCM over Arabic ASR WebSocket and return the full transcript.
 * Auth: ?key= workspace API key (server only).
 */
export const transcribeArabicFileOverWs = async (
  pcm: Buffer,
  options?: { timeoutMs?: number },
): Promise<ArabicFileTranscriptionResult> => {
  const timeoutMs = options?.timeoutMs ?? 10 * 60_000;
  const wsUrl = buildArabicFileWsUrl();
  const audioSeconds = pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);

  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this Node runtime");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let transcript = "";
    const segments: ArabicFileTranscriptionResult["segments"] = [];
    let segIndex = 0;
    let ws: WebSocket;

    const timer = setTimeout(() => {
      finish(new Error("Arabic file transcription timed out"));
    }, timeoutMs);

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close();
        }
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else {
        resolve({
          transcript: transcript.trim(),
          segments,
          audioSeconds,
        });
      }
    };

    ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    ws.onerror = () => {
      finish(new Error("Arabic ASR WebSocket connection failed"));
    };

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: "start", sample_rate: SAMPLE_RATE }));
      } catch (e) {
        finish(e instanceof Error ? e : new Error("Failed to send Arabic start"));
      }
    };

    const sendPcmAndStop = async () => {
      try {
        for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
          if (ws.readyState !== WebSocket.OPEN) {
            throw new Error("Arabic ASR WebSocket closed while sending audio");
          }
          const slice = pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length));
          // Copy into a fresh ArrayBuffer — WS send rejects Node Buffer views.
          const copy = Uint8Array.from(slice);
          ws.send(copy.buffer);
        }
        ws.send(JSON.stringify({ type: "stop" }));
      } catch (e) {
        finish(e instanceof Error ? e : new Error("Failed to stream Arabic audio"));
      }
    };

    let startedStreaming = false;

    ws.onmessage = (event) => {
      let raw: string;
      if (typeof event.data === "string") {
        raw = event.data;
      } else if (event.data instanceof ArrayBuffer) {
        raw = new TextDecoder("utf-8").decode(event.data);
      } else if (ArrayBuffer.isView(event.data)) {
        raw = new TextDecoder("utf-8").decode(event.data as ArrayBufferView);
      } else {
        return;
      }

      let msg: { type?: string; text?: string; delta?: string; transcript?: string };
      try {
        msg = JSON.parse(raw) as typeof msg;
      } catch {
        return;
      }

      if (msg.type === "ready") {
        if (!startedStreaming) {
          startedStreaming = true;
          void sendPcmAndStop();
        }
        return;
      }

      if (msg.type === "error") {
        finish(new Error(typeof msg.text === "string" ? msg.text : "Arabic ASR error"));
        return;
      }

      if (msg.type === "delta" || msg.type === "partial") {
        const piece = String(msg.delta || msg.text || msg.transcript || "").trim();
        if (piece) transcript = mergeStreamingText(transcript, piece);
        return;
      }

      if (msg.type === "segment" || msg.type === "final") {
        const text = String(msg.text || msg.transcript || "").trim();
        if (!text) return;
        transcript = mergeStreamingText(transcript, text);
        const t0 = segIndex * 1;
        segIndex += 1;
        segments.push({ start: t0, end: t0 + 1, text });
        return;
      }

      if (msg.type === "done" || msg.type === "stopped") {
        finish();
      }
    };

    ws.onclose = () => {
      if (!settled) {
        // Prefer returning whatever we collected rather than failing hard.
        if (transcript.trim()) finish();
        else finish(new Error("Arabic ASR WebSocket closed before transcript"));
      }
    };
  });
};

export const newArabicWsJobId = () => `arabic-ws:${randomUUID()}`;
