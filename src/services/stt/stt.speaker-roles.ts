import { z } from "zod";
import { LlmModelError, requestLlmCompletion, type UserLlmSettings } from "../llm/llm.model";

/**
 * Call-center role detection: when a diarized transcript has exactly two
 * speakers, ask an LLM (Gemma on Google AI Studio by default) which one is the
 * agent, then relabel the result as Agent / Caller. Any failure keeps the
 * generic Speaker 1 / Speaker 2 labels — this step must never fail a job.
 */

type JsonRecord = Record<string, unknown>;
export type SpeakerRole = "agent" | "caller";
export type SpeakerRolesInfo = {
  roles: Record<string, SpeakerRole>;
  model: string;
  confidence: number;
};

const SEGMENT_SPEAKER_KEYS = ["speaker", "speaker_label", "speakerLabel", "speaker_id", "speakerId"];
const SPEAKER_ID_KEYS = ["id", "speaker", "speaker_id", "speakerId", "label"];
const MAX_TURNS = 60;
const MAX_CHARS = 8000;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pickId = (source: JsonRecord, keys: string[]) => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
};

const segmentsOf = (result: JsonRecord) =>
  Array.isArray(result.segments) ? result.segments.filter(isRecord) : [];

const speakersOf = (result: JsonRecord) =>
  Array.isArray(result.speakers) ? result.speakers.filter(isRecord) : [];

/** Raw speaker ids in order of first appearance. */
export const distinctSpeakerIds = (result: unknown): string[] => {
  if (!isRecord(result)) return [];
  const ids: string[] = [];
  for (const seg of segmentsOf(result)) {
    const id = pickId(seg, SEGMENT_SPEAKER_KEYS);
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length) return ids;
  for (const sp of speakersOf(result)) {
    const id = pickId(sp, SPEAKER_ID_KEYS);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

export const hasSpeakerRoles = (result: unknown) =>
  isRecord(result) && isRecord(result.speaker_roles);

export const roleSettingsFromEnv = (): UserLlmSettings | null => {
  const apiKey = process.env.STT_ROLE_LLM_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    provider: "gemini",
    model_name: process.env.STT_ROLE_LLM_MODEL?.trim() || "gemma-4-26b-a4b-it",
    endpoint: process.env.STT_ROLE_LLM_ENDPOINT?.trim() || null,
    api_key: apiKey,
    temperature: 0,
    max_tokens: 512,
    top_p: 1,
    timeout_ms: Number(process.env.STT_ROLE_LLM_TIMEOUT_MS) || 30_000,
  };
};

const minConfidence = () => {
  const value = Number(process.env.STT_ROLE_MIN_CONFIDENCE);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.6;
};

export const buildRoleDialogue = (result: JsonRecord, ids: string[]) => {
  const lines: string[] = [];
  let chars = 0;
  for (const seg of segmentsOf(result)) {
    const id = pickId(seg, SEGMENT_SPEAKER_KEYS);
    const text = typeof seg.text === "string" ? seg.text.replace(/\s+/g, " ").trim() : "";
    if (!id || !text) continue;
    const line = `S${ids.indexOf(id) + 1}: ${text}`;
    if (lines.length >= MAX_TURNS || chars + line.length > MAX_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join("\n");
};

export const ROLE_SYSTEM_PROMPT = [
  "You analyse transcripts of customer-service phone calls.",
  "Exactly two people speak: S1 and S2. Decide which one is the call-center AGENT and which is the CALLER (customer).",
  "Agent cues: greets with a company or department name, offers help, asks for or verifies account details, follows a script, explains policy, puts the caller on hold, closes the call politely.",
  "Caller cues: describes their own problem or request, answers verification questions, asks for help.",
  "The transcript may be in any Indian language, Arabic, English or a code-mixed form; reason about meaning, not language.",
  'Reply with only a JSON object and nothing else: {"agent":"S1" or "S2","confidence":number between 0 and 1}',
].join("\n");

const roleReplyValidator = z.object({
  agent: z.string().transform((v) => v.trim().toUpperCase()).pipe(z.enum(["S1", "S2"])),
  confidence: z.coerce.number().min(0).max(1),
});

/** Tolerates ```json fences and stray prose around the object. */
export const parseRoleReply = (raw: string) => {
  const unfenced = raw.replace(/```(?:json)?/gi, "");
  const match = unfenced.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = roleReplyValidator.safeParse(JSON.parse(match[0]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const RETRY_DELAYS_MS = [1000, 2500];

/** Google AI Studio returns sporadic 500/503 for Gemma; retry those, not timeouts or 4xx. */
const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const transient = error instanceof LlmModelError && (error.httpStatus === 502 || error.httpStatus === 503);
      const delay = RETRY_DELAYS_MS[attempt];
      if (!transient || delay === undefined) throw error;
      console.warn(`STT speaker roles: transient LLM error, retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

/** Returns role info, or null when roles should not / could not be assigned. */
export const classifyAgentCaller = async (result: unknown): Promise<SpeakerRolesInfo | null> => {
  if (!isRecord(result) || hasSpeakerRoles(result)) return null;
  const ids = distinctSpeakerIds(result);
  if (ids.length !== 2) return null;

  const settings = roleSettingsFromEnv();
  if (!settings) return null;

  const dialogue = buildRoleDialogue(result, ids);
  if (!dialogue) return null;

  try {
    const input = { system: ROLE_SYSTEM_PROMPT, turns: [{ role: "user" as const, text: `Transcript:\n${dialogue}` }], temperature: 0 };
    const fallbackModel = process.env.STT_ROLE_LLM_FALLBACK_MODEL?.trim();
    let usedModel = settings.model_name;
    let completion;
    try {
      completion = await withRetry(() => requestLlmCompletion(input, settings));
    } catch (error) {
      // Gemma on AI Studio is preview-tier and has bursts of 500s; try a second model once.
      if (!fallbackModel || fallbackModel === settings.model_name || !(error instanceof LlmModelError)) throw error;
      console.warn(`STT speaker roles: ${settings.model_name} failed (${error.message}), trying ${fallbackModel}`);
      usedModel = fallbackModel;
      completion = await withRetry(() => requestLlmCompletion(input, { ...settings, model_name: fallbackModel }));
    }
    const reply = parseRoleReply(completion.rawText);
    if (!reply) {
      console.warn("STT speaker roles: unparseable LLM reply", completion.rawText.slice(0, 200));
      return null;
    }
    if (reply.confidence < minConfidence()) {
      console.info(`STT speaker roles: low confidence ${reply.confidence} (< ${minConfidence()}), keeping Speaker N labels`);
      return null;
    }

    const [first, second] = ids as [string, string];
    const agentId = reply.agent === "S1" ? first : second;
    const callerId = agentId === first ? second : first;
    return {
      roles: { [agentId]: "agent", [callerId]: "caller" },
      model: usedModel,
      confidence: reply.confidence,
    };
  } catch (error) {
    console.warn("STT speaker roles: LLM request failed", error instanceof Error ? error.message : error);
    return null;
  }
};

const ROLE_LABEL: Record<SpeakerRole, string> = { agent: "Agent", caller: "Caller" };

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rewrites "<raw id>:" at the start of each line, e.g. "Speaker 1: hi" → "Agent: hi". */
export const relabelSpeakerText = (text: string, info: SpeakerRolesInfo) =>
  Object.entries(info.roles).reduce(
    (out, [rawId, role]) => out.replace(new RegExp(`^(\\s*)${escapeRegExp(rawId)}(?=\\s*:)`, "gm"), `$1${ROLE_LABEL[role]}`),
    text,
  );

/** Relabels segments/speakers in a copy of the result; keeps the raw id as speakerId. */
export const applySpeakerRoles = (result: JsonRecord, info: SpeakerRolesInfo): JsonRecord => {
  const relabel = (item: JsonRecord, keys: string[], labelKey: string) => {
    const id = pickId(item, keys);
    const role = id ? info.roles[id] : undefined;
    return role ? { ...item, speakerId: id, [labelKey]: ROLE_LABEL[role], role } : item;
  };

  return {
    ...result,
    // The ASR's plain text ("Speaker 1: …" lines) becomes the API `transcript`, so relabel it too.
    ...(typeof result.text === "string" ? { text: relabelSpeakerText(result.text, info) } : {}),
    ...(Array.isArray(result.segments)
      ? { segments: result.segments.map((seg) => (isRecord(seg) ? relabel(seg, SEGMENT_SPEAKER_KEYS, "speaker") : seg)) }
      : {}),
    ...(Array.isArray(result.speakers)
      ? { speakers: result.speakers.map((sp) => (isRecord(sp) ? relabel(sp, SPEAKER_ID_KEYS, "label") : sp)) }
      : {}),
    speaker_roles: info,
  };
};
