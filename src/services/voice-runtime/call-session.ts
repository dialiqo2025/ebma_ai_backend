import { eq } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { VoiceCalls, VoiceCallTurns, type VoiceBots, type VoiceBotWebhookTool } from "../../schema";
import { recordUsage } from "../billing/billing.provider";
import { requestLlmCompletion, streamLlmCompletion, type LlmTurn, type UserLlmSettings } from "../llm/llm.model";
import { loadPrivateUserConfig } from "../llm/llm.user.provider";
import { openTtsModelStream } from "../tts/tts.model";
import { AsrClient, type AsrFinal } from "./asr-client";
import { pcmDurationMs, resamplePcm16, wavFromPcm16 } from "./audio.util";
import { errorText, vlog } from "./voice-log";

type VoiceBot = typeof VoiceBots.$inferSelect;

/** How audio and control messages reach the caller. */
export type VoiceTransport = {
  /** Sample rate of the audio the caller side sends and expects back. */
  sampleRate: number;
  /** "json" = mod_audio_stream streamAudio messages (one WAV per sentence); "binary" = paced raw L16 frames. */
  playbackMode: "json" | "binary";
  sendJson: (message: Record<string, unknown>) => void;
  /** Send transcript / partial / latency / clear events (browser test client only). */
  uiEvents: boolean;
  sendBinary: (frame: Buffer) => void;
  close: () => void;
};

/** Call-center side actions. FreeSWITCH uses the Talkify callback API; the browser test uses JSON events. */
export type CallControl = {
  handoff: (payload: { conversationId: string; summary: string; reason: string }) => Promise<void>;
  hangup: (payload: { conversationId: string; summary: string; reason: string }) => Promise<void>;
  /** Flush audio the call center has already queued for playback (barge-in). */
  breakPlayback: () => Promise<void>;
};

const FRAME_MS = 20;
const MAX_TOOL_ROUNDS = 3;
const TAG_PATTERN = /\[\[(TRANSFER|END_CALL|TOOL:([a-z0-9_]+)\s*(\{[\s\S]*?\})?)\]\]/;

const buildSystemPrompt = (bot: VoiceBot, metadata: Record<string, unknown>) => {
  const tools = bot.tools.length
    ? bot.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")
    : "(none)";
  const context = Object.entries(metadata)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");

  return `${bot.system_prompt}

## Live phone call rules
- You are speaking on a live phone call. Your words are converted to speech.
- Reply in 1-3 short spoken sentences. No markdown, lists, emojis, URLs or symbols that cannot be spoken.
- Reply in the caller's language (configured language code: ${bot.language}).
- The caller's words come from speech recognition and may contain mistakes; ask again if something is unclear.
${bot.handoff_enabled
    ? "- If the caller asks for a human, or you cannot help, say one short sentence that you are connecting them to an agent, then output [[TRANSFER]]."
    : "- Transfers to a human agent are not available on this line."}
- When the conversation is complete, say a short goodbye, then output [[END_CALL]].
- To use a tool, output [[TOOL:tool_name {"arg": "value"}]] on its own, with nothing after it. You will receive the result.
Available tools:
${tools}
${context ? `\nCall context: ${context}` : ""}`.trim();
};

/** Split streamed text into speakable sentences. */
const takeSentence = (buffer: string, final: boolean): [string, string] | null => {
  // First sentence end that leaves a chunk worth synthesizing (skips "Hi." style fragments).
  const boundaries = /[.!?।|]\s|\n/g;
  for (let match = boundaries.exec(buffer); match; match = boundaries.exec(buffer)) {
    if (match.index >= 8) return [buffer.slice(0, match.index + 1).trim(), buffer.slice(match.index + 1)];
  }
  if (buffer.length > 220) {
    const soft = Math.max(buffer.lastIndexOf(", ", 220), buffer.lastIndexOf(" ", 220));
    if (soft > 40) return [buffer.slice(0, soft + 1).trim(), buffer.slice(soft + 1)];
  }
  if (final && buffer.trim()) return [buffer.trim(), ""];
  return null;
};

export class CallSession {
  private readonly startedAt = Date.now();
  private callUuid: string | null = null;
  private asr: AsrClient | null = null;
  private llmSettings: UserLlmSettings | undefined;
  private history: LlmTurn[] = [];
  private turnIndex = 0;

  private generation = 0;
  private abort: AbortController | null = null;
  private ttsChain: Promise<void> = Promise.resolve();
  private generating = false;
  /** Sentences of the in-flight reply already sent to TTS. */
  private currentSpoken = "";
  private ttsPending = 0;
  private playingUntil = 0;
  private outQueue: Buffer[] = [];
  private pacer: NodeJS.Timeout | null = null;

  private lastActivity = Date.now();
  private silencePrompts = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private ending = false;
  private finalized = false;
  private endReason = "caller_hangup";
  private status = "completed";
  private summary: string | null = null;
  private spokenCharacters = 0;
  private llmCharacters = 0;
  private detectedLanguage: string | null = null;

  constructor(
    private readonly bot: VoiceBot,
    private readonly transport: VoiceTransport,
    private readonly control: CallControl,
    private readonly context: {
      userUuid: string;
      connectionUuid: string | null;
      externalCallId: string | null;
      caller: string | null;
      callee: string | null;
      metadata: Record<string, unknown>;
    },
  ) {}

  get conversationId() {
    return this.callUuid;
  }

  private get tag() {
    return `call ${this.callUuid ?? "new"}${this.context.externalCallId ? ` fs:${this.context.externalCallId}` : ""}`;
  }

  private ui(message: Record<string, unknown>) {
    if (this.transport.uiEvents) this.transport.sendJson(message);
  }

  async start() {
    const [call] = await db.insert(VoiceCalls).values({
      user_uuid: this.context.userUuid,
      bot_uuid: this.bot.bot_uuid,
      connection_uuid: this.context.connectionUuid,
      external_call_id: this.context.externalCallId,
      caller: this.context.caller,
      callee: this.context.callee,
      metadata: this.context.metadata,
    }).returning({ call_uuid: VoiceCalls.call_uuid });
    this.callUuid = call!.call_uuid;
    this.ui({ type: "session", conversation_id: this.callUuid });
    vlog.info(this.tag, "call row created", {
      bot: this.bot.name,
      language: this.bot.language,
      caller: this.context.caller,
      did: this.context.callee,
      sample_rate: this.transport.sampleRate,
      playback_mode: this.transport.playbackMode,
    });

    const config = await loadPrivateUserConfig(this.context.userUuid);
    this.llmSettings = config ?? undefined;
    vlog.info(this.tag, "llm config", config
      ? { source: "user", provider: config.provider, model: config.model_name }
      : { source: "env", provider: process.env.LLM_PROVIDER ?? null, model: process.env.LLM_MODEL ?? null });

    this.asr = new AsrClient({
      sampleRate: this.transport.sampleRate,
      language: this.bot.language,
      mode: this.bot.stt_mode,
      endSilenceMs: this.bot.end_silence_ms,
    });
    this.asr.on("ready", () => vlog.info(this.tag, "asr ready"));
    this.asr.on("closed", () => vlog.info(this.tag, "asr closed"));
    this.asr.on("speaking", (speaking) => {
      vlog.debug(this.tag, `asr vad ${speaking ? "speech start" : "speech end"}`, { bot_talking: this.isBotTalking() });
      if (!speaking) return;
      this.lastActivity = Date.now();
      if (this.bot.barge_in && this.isBotTalking()) void this.interrupt();
    });
    this.asr.on("partial", (text) => {
      this.lastActivity = Date.now();
      vlog.debug(this.tag, "asr partial", { text });
      this.ui({ type: "partial", text });
    });
    this.asr.on("final", (final) => void this.onUserFinal(final));
    this.asr.on("error", (error) => {
      vlog.error(this.tag, "asr error", { error: error.message });
      if (!this.ending) void this.end(this.bot.handoff_enabled ? "transfer" : "hangup", "asr_unavailable");
    });
    this.asr.connect();

    if (this.transport.playbackMode === "binary") {
      const frameBytes = (this.transport.sampleRate * FRAME_MS * 2) / 1000;
      this.pacer = setInterval(() => this.pumpFrames(frameBytes), FRAME_MS);
    }
    this.watchdog = setInterval(() => this.checkTimers(), 1000);

    if (this.bot.greeting.trim()) {
      vlog.info(this.tag, "speaking greeting", { text: this.bot.greeting.trim() });
      this.history.push({ role: "assistant", text: this.bot.greeting.trim() });
      void this.saveTurn("assistant", this.bot.greeting.trim(), null, false);
      this.speak(this.bot.greeting.trim(), this.generation);
    }
  }

  /** Caller audio from the call center (L16 mono at transport.sampleRate). */
  onCallerAudio(frame: Buffer) {
    this.asr?.sendAudio(frame);
  }

  // ------------------------------------------------------------ conversation

  private async onUserFinal(final: AsrFinal) {
    if (this.ending) return;
    this.lastActivity = Date.now();
    this.silencePrompts = 0;
    if (final.lang) this.detectedLanguage = final.lang;
    vlog.info(this.tag, "caller said", { text: final.text, lang: final.lang, asr_latency_ms: final.latency_ms, audio_s: final.audio_s });
    if (this.isBotTalking() || this.generating) await this.interrupt();

    this.ui({ type: "transcript", role: "user", text: final.text });
    void this.saveTurn("user", final.text, final.latency_ms ?? null, false);

    // Merge with an unanswered previous user turn so the model sees one message.
    const last = this.history[this.history.length - 1];
    if (last?.role === "user") last.text = `${last.text} ${final.text}`;
    else this.history.push({ role: "user", text: final.text });

    void this.respond(Date.now());
  }

  private async respond(userDoneAt: number, toolRound = 0) {
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.generating = true;

    let pending = "";
    let spoken = "";
    let raw = "";
    let action: { kind: "transfer" | "end" | "tool"; name?: string; args?: string } | null = null;
    let firstAudio = true;
    let firstToken = true;
    const llmStartedAt = Date.now();
    this.currentSpoken = "";
    vlog.info(this.tag, "llm request", { generation, turns: this.history.length, tool_round: toolRound });

    const emit = (final: boolean) => {
      for (let piece = takeSentence(pending, final); piece; piece = takeSentence(pending, final)) {
        const [sentence, rest] = piece;
        pending = rest;
        spoken += `${sentence} `;
        this.currentSpoken = spoken;
        this.speak(sentence, generation, firstAudio ? userDoneAt : null);
        firstAudio = false;
      }
    };

    try {
      const completion = await streamLlmCompletion({
        system: buildSystemPrompt(this.bot, this.context.metadata),
        turns: this.history,
        temperature: this.bot.temperature,
      }, this.llmSettings, {
        signal: abort.signal,
        onText: (delta) => {
          if (action || generation !== this.generation) return;
          if (firstToken) {
            firstToken = false;
            vlog.info(this.tag, "llm first token", { ms: Date.now() - llmStartedAt });
          }
          raw += delta;
          pending += delta;
          const tagStart = pending.indexOf("[[");
          if (tagStart >= 0) {
            const match = pending.match(TAG_PATTERN);
            if (!match) {
              // Speak what precedes a tag that is still streaming in.
              const before = pending.slice(0, tagStart);
              const after = pending.slice(tagStart);
              pending = before;
              emit(false);
              pending += after;
              return;
            }
            const beforeTag = pending.slice(0, match.index);
            pending = beforeTag;
            emit(true);
            if (match[1] === "TRANSFER") action = { kind: "transfer" };
            else if (match[1] === "END_CALL") action = { kind: "end" };
            else action = { kind: "tool", name: match[2]!, args: match[3] ?? "{}" };
            vlog.info(this.tag, "llm control tag", { tag: match[0] });
            if (action.kind === "tool") abort.abort();
            return;
          }
          emit(false);
        },
      });
      this.llmCharacters += completion.rawText.length;
      vlog.info(this.tag, "llm done", { ms: Date.now() - llmStartedAt, chars: completion.rawText.length });
    } catch (error) {
      if (abort.signal.aborted) {
        vlog.info(this.tag, "llm aborted", { generation, reason: action ? "tool call" : "interrupted" });
      } else {
        vlog.error(this.tag, "llm error", { error: errorText(error), ms: Date.now() - llmStartedAt });
        if (!spoken.trim()) {
          this.generating = false;
          if (generation === this.generation) void this.end(this.bot.handoff_enabled ? "transfer" : "hangup", "llm_unavailable");
          return;
        }
      }
    }

    if (generation !== this.generation) return; // interrupted; interrupt() kept the spoken part
    if (!action) emit(true);
    this.generating = false;
    this.currentSpoken = "";

    const assistantText = raw.trim() || spoken.trim();
    vlog.info(this.tag, "bot reply", { text: spoken.trim(), action: (action as { kind: string } | null)?.kind ?? null });
    if (assistantText) {
      this.history.push({ role: "assistant", text: assistantText });
      if (spoken.trim()) {
        this.ui({ type: "transcript", role: "assistant", text: spoken.trim() });
        void this.saveTurn("assistant", spoken.trim(), null, false);
      }
    }

    const taken = action as { kind: "transfer" | "end" | "tool"; name?: string; args?: string } | null;
    if (taken?.kind === "transfer") {
      if (this.bot.handoff_enabled) void this.end("transfer", "bot_transfer");
      else void this.end("hangup", "bot_end");
    } else if (taken?.kind === "end") {
      void this.end("hangup", "bot_end");
    } else if (taken?.kind === "tool") {
      const result = toolRound < MAX_TOOL_ROUNDS
        ? await this.runTool(taken.name!, taken.args!)
        : "Tool limit reached. Answer without tools.";
      if (generation !== this.generation || this.ending) return;
      this.history.push({ role: "user", text: `[tool ${taken.name} result] ${result}` });
      void this.respond(userDoneAt, toolRound + 1);
    }
  }

  private async runTool(name: string, rawArgs: string) {
    const tool = this.bot.tools.find((candidate: VoiceBotWebhookTool) => candidate.name === name);
    vlog.info(this.tag, "tool call", { name, args: rawArgs, known: Boolean(tool) });
    if (!tool) return `Unknown tool ${name}.`;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs);
    } catch {
      // keep empty args
    }
    try {
      const call = { conversation_id: this.callUuid, external_call_id: this.context.externalCallId, caller: this.context.caller, metadata: this.context.metadata };
      const url = tool.method === "GET"
        ? `${tool.url}${tool.url.includes("?") ? "&" : "?"}${new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])).toString()}`
        : tool.url;
      const response = await fetch(url, {
        method: tool.method ?? "POST",
        headers: { "Content-Type": "application/json", ...(tool.headers ?? {}) },
        ...(tool.method === "GET" ? {} : { body: JSON.stringify({ tool: name, arguments: args, call }) }),
        signal: AbortSignal.timeout(8000),
      });
      const text = (await response.text()).slice(0, 2000);
      vlog.info(this.tag, "tool result", { name, status: response.status, body: text.slice(0, 300) });
      return response.ok ? text || "OK" : `Tool failed with HTTP ${response.status}: ${text}`;
    } catch (error) {
      vlog.error(this.tag, "tool failed", { name, error: errorText(error) });
      return `Tool failed: ${error instanceof Error ? error.message : "unknown error"}`;
    }
  }

  // ------------------------------------------------------------ speech output

  private isBotTalking() {
    return this.ttsPending > 0 || Date.now() < this.playingUntil || this.outQueue.length > 0;
  }

  /** Queue a sentence for TTS; sentences play strictly in order. */
  private speak(text: string, generation: number, userDoneAt: number | null = null) {
    this.ttsPending++;
    this.ttsChain = this.ttsChain
      .then(() => (generation === this.generation ? this.synthesize(text, generation, userDoneAt) : undefined))
      .catch((error) => vlog.error(this.tag, "tts error", { text, error: errorText(error) }))
      .finally(() => {
        this.ttsPending--;
      });
  }

  private async synthesize(text: string, generation: number, userDoneAt: number | null) {
    const language = this.bot.language === "auto" ? this.detectedLanguage ?? "hi" : this.bot.language;
    const ttsStartedAt = Date.now();
    vlog.info(this.tag, "tts request", { text, language });
    const stream = await openTtsModelStream({
      text,
      language,
      voiceMode: this.bot.voice_mode === "clone" ? "clone" : "default",
      ...(this.bot.voice_id ? { voiceId: this.bot.voice_id } : {}),
      speed: this.bot.speed,
      pitch: this.bot.pitch,
      outputFormat: "wav",
    });
    this.spokenCharacters += text.length;

    const targetRate = this.transport.sampleRate;
    const collected: Buffer[] = [];
    let carry: Buffer = Buffer.alloc(0);
    let first = true;
    for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
      if (generation !== this.generation) return;
      let data: Buffer = Buffer.concat([carry, Buffer.from(chunk)]);
      if (data.length % 2) {
        carry = data.subarray(data.length - 1);
        data = data.subarray(0, data.length - 1);
      } else {
        carry = Buffer.alloc(0);
      }
      if (!data.length) continue;
      const pcm = resamplePcm16(data, stream.sampleRate, targetRate);
      if (first) vlog.info(this.tag, "tts first audio", { ms: Date.now() - ttsStartedAt, tts_rate: stream.sampleRate, out_rate: targetRate });
      vlog.debug(this.tag, "tts chunk", { bytes: pcm.length });
      if (this.transport.playbackMode === "binary") {
        if (first && userDoneAt) this.recordLatency(userDoneAt);
        this.outQueue.push(pcm);
      } else {
        collected.push(pcm);
      }
      first = false;
    }

    if (this.transport.playbackMode === "json" && generation === this.generation) {
      const pcm = Buffer.concat(collected);
      if (!pcm.length) {
        vlog.warn(this.tag, "tts returned no audio", { text });
        return;
      }
      if (userDoneAt) this.recordLatency(userDoneAt);
      vlog.info(this.tag, "streamAudio sent", { audio_ms: Math.round(pcmDurationMs(pcm.length, targetRate)), tts_ms: Date.now() - ttsStartedAt });
      this.transport.sendJson({
        type: "streamAudio",
        data: { audioDataType: "wav", sampleRate: targetRate, audioData: wavFromPcm16(pcm, targetRate).toString("base64") },
      });
      this.playingUntil = Math.max(this.playingUntil, Date.now()) + pcmDurationMs(pcm.length, targetRate) + 150;
    }
  }

  private recordLatency(userDoneAt: number) {
    vlog.info(this.tag, "reply latency", { ms: Date.now() - userDoneAt });
    this.ui({ type: "latency", ms: Date.now() - userDoneAt });
  }

  private pumpFrames(frameBytes: number) {
    if (!this.outQueue.length) return;
    let frame = Buffer.alloc(0);
    while (frame.length < frameBytes && this.outQueue.length) {
      const head = this.outQueue[0]!;
      const need = frameBytes - frame.length;
      if (head.length <= need) {
        frame = Buffer.concat([frame, head]);
        this.outQueue.shift();
      } else {
        frame = Buffer.concat([frame, head.subarray(0, need)]);
        this.outQueue[0] = head.subarray(need);
      }
    }
    this.transport.sendBinary(frame);
    this.playingUntil = Date.now() + FRAME_MS * 2;
  }

  /** Barge-in: stop generating, drop queued audio and tell the call center to flush its buffer. */
  private async interrupt() {
    vlog.info(this.tag, "barge-in", { generating: this.generating, playing: Date.now() < this.playingUntil, queued_chunks: this.outQueue.length });
    if (this.currentSpoken.trim()) {
      // Keep what was already said so the model knows where it was cut off.
      this.history.push({ role: "assistant", text: `${this.currentSpoken.trim()} …` });
      void this.saveTurn("assistant", this.currentSpoken.trim(), null, true);
      this.currentSpoken = "";
    }
    this.generation++;
    this.abort?.abort();
    this.generating = false;
    this.outQueue = [];
    const wasPlaying = Date.now() < this.playingUntil;
    this.playingUntil = 0;
    this.ui({ type: "clear" });
    if (wasPlaying && this.transport.playbackMode === "json") {
      await this.control.breakPlayback().catch((error) => vlog.error(this.tag, "break callback failed", { error: errorText(error) }));
    }
  }

  private async waitForPlayback(maxMs = 15_000) {
    const deadline = Date.now() + maxMs;
    await this.ttsChain;
    while (this.isBotTalking() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // ------------------------------------------------------------ timers and ending

  private checkTimers() {
    if (this.ending) return;
    if (Date.now() - this.startedAt > this.bot.max_duration_s * 1000) {
      vlog.info(this.tag, "max duration reached", { max_duration_s: this.bot.max_duration_s });
      void this.sayAndEnd(this.bot.goodbye_message, "hangup", "max_duration");
      return;
    }
    if (this.generating || this.isBotTalking()) {
      this.lastActivity = Date.now();
      return;
    }
    if (Date.now() - this.lastActivity > this.bot.silence_timeout_s * 1000) {
      this.lastActivity = Date.now();
      vlog.info(this.tag, "caller silent", { seconds: this.bot.silence_timeout_s, prompt: this.silencePrompts + 1 });
      if (this.silencePrompts++ === 0) {
        this.history.push({ role: "user", text: "[the caller has been silent; briefly check if they are still there]" });
        void this.respond(Date.now());
      } else {
        void this.sayAndEnd(this.bot.goodbye_message, "hangup", "caller_silent");
      }
    }
  }

  private async sayAndEnd(message: string, kind: "transfer" | "hangup", reason: string) {
    if (message.trim()) {
      this.speak(message.trim(), this.generation);
      void this.saveTurn("assistant", message.trim(), null, false);
    }
    await this.end(kind, reason);
  }

  /** Finish the bot's part of the call: wait for the last words, then hand off or hang up. */
  async end(kind: "transfer" | "hangup", reason: string) {
    if (this.ending) return;
    this.ending = true;
    vlog.info(this.tag, "ending bot part of call", { kind, reason });
    if (kind === "transfer" && this.bot.handoff_message.trim() && reason !== "bot_transfer") {
      this.speak(this.bot.handoff_message.trim(), this.generation);
    }
    await this.waitForPlayback();

    this.endReason = reason;
    this.status = kind === "transfer" ? "transferred" : "completed";
    this.summary = await this.summarize();
    vlog.info(this.tag, "summary", { summary: this.summary });
    const payload = { conversationId: this.callUuid ?? "", summary: this.summary ?? "", reason };
    try {
      if (kind === "transfer") await this.control.handoff(payload);
      else await this.control.hangup(payload);
      vlog.info(this.tag, `${kind} done`);
    } catch (error) {
      vlog.error(this.tag, `${kind} callback failed`, { error: errorText(error) });
      this.status = "failed";
    }
    // The call center normally closes the stream; make sure we do not linger.
    setTimeout(() => this.transport.close(), 10_000).unref();
  }

  private async summarize() {
    if (this.summary !== null) return this.summary;
    const transcript = this.history
      .filter((turn) => !turn.text.startsWith("[tool ") && !turn.text.startsWith("[the caller"))
      .map((turn) => `${turn.role === "user" ? "Caller" : "Bot"}: ${turn.text.replace(/\[\[[\s\S]*?\]\]/g, "")}`)
      .join("\n");
    if (!this.history.some((turn) => turn.role === "user")) return "";
    try {
      const result = await requestLlmCompletion({
        system: "Summarize this phone conversation for the human agent taking over. 2-3 short sentences in English: who the caller is, what they want, what was already done or promised. No preamble.",
        turns: [{ role: "user", text: transcript.slice(-12_000) }],
        temperature: 0.2,
      }, this.llmSettings);
      this.llmCharacters += transcript.length + result.rawText.length;
      return result.rawText.trim().slice(0, 1000);
    } catch (error) {
      vlog.error(this.tag, "summary failed", { error: errorText(error) });
      return "";
    }
  }

  /** Called once when the call-center stream closes. */
  async finalize() {
    if (this.finalized) return;
    this.finalized = true;
    this.generation++;
    this.abort?.abort();
    if (this.pacer) clearInterval(this.pacer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.asr?.close();
    if (!this.callUuid) return;

    if (this.summary === null) this.summary = await this.summarize();
    const durationSeconds = (Date.now() - this.startedAt) / 1000;
    vlog.info(this.tag, "finalized", {
      status: this.status,
      end_reason: this.endReason,
      seconds: Math.round(durationSeconds),
      turns: this.turnIndex,
      stt_seconds: Math.round(this.asr?.audioSeconds ?? 0),
      tts_chars: this.spokenCharacters,
    });
    await db.update(VoiceCalls).set({
      status: this.status,
      end_reason: this.endReason,
      summary: this.summary,
      duration_seconds: durationSeconds,
      ended_at: new Date(),
    }).where(eq(VoiceCalls.call_uuid, this.callUuid));

    const key = `voice:${this.callUuid}`;
    const sttSeconds = Math.max(this.asr?.audioSeconds ?? 0, 0);
    void recordUsage({ userUuid: this.context.userUuid, type: "stt_seconds", quantity: Math.ceil(sttSeconds), idempotencyKey: `${key}:stt`, metadata: { voice_call: this.callUuid } });
    void recordUsage({ userUuid: this.context.userUuid, type: "tts_characters", quantity: this.spokenCharacters, idempotencyKey: `${key}:tts`, metadata: { voice_call: this.callUuid } });
    void recordUsage({ userUuid: this.context.userUuid, type: "llm_tokens", quantity: Math.ceil(this.llmCharacters / 4), idempotencyKey: `${key}:llm`, metadata: { voice_call: this.callUuid, estimated: true } });
  }

  private async saveTurn(role: "user" | "assistant", text: string, latencyMs: number | null, interrupted: boolean) {
    if (!this.callUuid) return;
    const turnIndex = this.turnIndex++;
    try {
      await db.insert(VoiceCallTurns).values({ call_uuid: this.callUuid, turn_index: turnIndex, role, text, latency_ms: latencyMs, interrupted });
    } catch (error) {
      vlog.error(this.tag, "could not save turn", { error: errorText(error) });
    }
  }
}
