/**
 * Control tags for the GPU speech model.
 * Confirmed format: `<|emotion:anger|>` in `input`.
 * Style / speed / pause / sfx follow the same `<|…|>` convention.
 */

export const TTS_EMOTIONS = [
  "affection",
  "amusement",
  "anger",
  "arousal",
  "awe",
  "bitterness",
  "confusion",
  "contemplation",
  "contentment",
  "determination",
  "disgust",
  "elation",
  "enthusiasm",
  "fear",
  "helplessness",
  "longing",
  "pride",
  "relief",
  "sadness",
  "shame",
  "surprise",
] as const;

export type TtsEmotion = (typeof TTS_EMOTIONS)[number];

export type TtsStyleTag = {
  id: string;
  label: string;
  /** Exact token inserted into `input`. */
  token: string;
  /** Emotion/style/speed/pitch set delivery for the whole request (put them first); pause/sfx go inline where they happen. */
  kind: "emotion" | "style" | "speed" | "pause" | "sfx";
};

export type TtsStyleTagGroup = {
  id: string;
  label: string;
  tags: TtsStyleTag[];
};

export const TTS_STYLE_TAG_GROUPS: TtsStyleTagGroup[] = [
  {
    id: "emotion",
    label: "EMOTION",
    tags: TTS_EMOTIONS.map((name) => ({
      id: `emotion-${name}`,
      label: name,
      token: `<|emotion:${name}|>`,
      kind: "emotion" as const,
    })),
  },
  {
    id: "style",
    label: "STYLE",
    tags: (
      [
        ["singing", "singing"],
        ["shouting", "shouting"],
        ["whispering", "whispering"],
      ] as const
    ).map(([id, label]) => ({
      id: `style-${id}`,
      label,
      token: `<|style:${id}|>`,
      kind: "style" as const,
    })),
  },
  // Hidden for now — keep catalog commented for later re-enable.
  // {
  //   id: "speed-pitch",
  //   label: "SPEED AND PITCH",
  //   tags: (
  //     [
  //       ["speed-very-slow", "speed very slow", "<|prosody:speed_very_slow|>"],
  //       ["speed-slow", "speed slow", "<|prosody:speed_slow|>"],
  //       ["speed-fast", "speed fast", "<|prosody:speed_fast|>"],
  //       ["speed-very-fast", "speed very fast", "<|prosody:speed_very_fast|>"],
  //       ["pitch-low", "pitch low", "<|prosody:pitch_low|>"],
  //       ["pitch-high", "pitch high", "<|prosody:pitch_high|>"],
  //       ["expressive-high", "expressive high", "<|prosody:expressive_high|>"],
  //       ["expressive-low", "expressive low", "<|prosody:expressive_low|>"],
  //     ] as const
  //   ).map(([id, label, token]) => ({
  //     id,
  //     label,
  //     token,
  //     kind: "speed" as const,
  //   })),
  // },
  // {
  //   id: "pauses",
  //   label: "PAUSES",
  //   tags: (
  //     [
  //       ["pause", "pause", "<|prosody:pause|>"],
  //       ["long-pause", "long pause", "<|prosody:long_pause|>"],
  //     ] as const
  //   ).map(([id, label, token]) => ({
  //     id,
  //     label,
  //     token,
  //     kind: "pause" as const,
  //   })),
  // },
  // {
  //   id: "sfx",
  //   label: "SOUND EFFECTS",
  //   tags: (
  //     [
  //       "cough",
  //       "laughter",
  //       "crying",
  //       "screaming",
  //       "burping",
  //       "humming",
  //       "sigh",
  //       "sniff",
  //       "sneeze",
  //     ] as const
  //   ).map((name) => ({
  //     id: `sfx-${name}`,
  //     label: name,
  //     token: `<|sfx:${name}|>`,
  //     kind: "sfx" as const,
  //   })),
  // },
];

export const TTS_EMOTION_OPTIONS: { value: TtsEmotion; label: string }[] =
  TTS_EMOTIONS.map((value) => ({
    value,
    label: value.charAt(0).toUpperCase() + value.slice(1),
  }));

const LEADING_CONTROL_TAG_RE = /^(?:<\|[^|]+?\|>\s*)+/;
const LEADING_EMOTION_TAG_RE = /^<\|emotion:[a-z_]+\|>\s*/i;

export const isTtsEmotion = (value: unknown): value is TtsEmotion =>
  typeof value === "string" && (TTS_EMOTIONS as readonly string[]).includes(value);

/**
 * If `emotion` is set and the text does not already start with control tags,
 * prefix `<|emotion:NAME|>`. Tags already in the text are left intact.
 */
export const applyEmotionPrefix = (text: string, emotion?: string | null) => {
  const trimmed = text.trimStart();
  if (!emotion || !isTtsEmotion(emotion)) return text;
  if (LEADING_CONTROL_TAG_RE.test(trimmed)) {
    // Text already has model tags (from the portal tag picker) — don't double-prefix.
    return text;
  }
  const withoutOldEmotion = text.replace(LEADING_EMOTION_TAG_RE, "").trimStart();
  return `<|emotion:${emotion}|>${withoutOldEmotion}`;
};

export const LAUGHTER_TAG = "<|sfx:laughter|>";

// A letter or combining mark: keeps matches to whole words, so हाँ ("yes") and हँसी ("laughter") are left alone.
const LETTER = "[\\p{L}\\p{M}]";
const DEVANAGARI_LAUGH_UNIT = "(?:हा|ह[ँं]|ही|हे)";
/**
 * Written laughs: two or more repeated syllables, e.g. हाहाहा, हँहँ, हंहं, हीही, हेहे, "हा हा हा",
 * Haha, hahaha, hehe, hihi. One syllable alone (हा, हे, ha) is a normal word and does not match.
 */
const WRITTEN_LAUGH_RE = new RegExp(
  `(?<!${LETTER})(?<!${LAUGHTER_TAG.replace(/[|]/g, "\\|")}\\s*)` +
    `(?:${DEVANAGARI_LAUGH_UNIT}(?:[\\s-]?${DEVANAGARI_LAUGH_UNIT})+|(?:ha|he|hi){2,}h?)` +
    `(?!${LETTER})`,
  "giu",
);

export const isLaughterTaggingEnabled = () =>
  process.env.TTS_AUTO_LAUGHTER_TAG?.trim().toLowerCase() !== "false";

/**
 * Puts `<|sfx:laughter|>` right before each written laugh, so the model laughs instead of
 * reading the word aloud. The model's docs ask for the tag *with* the onomatopoeia after it
 * (`<|sfx:laughter|>Haha`), so the laugh word is kept. Laughs already tagged are left as they are.
 */
export const applyLaughterTags = (text: string) =>
  isLaughterTaggingEnabled()
    ? text.replace(WRITTEN_LAUGH_RE, (laugh) => `${LAUGHTER_TAG}${laugh}`)
    : text;

/* ------------------------------------------------------------------------------------------------
 * Inline control tags, as documented by the Higgs model (`<|category:value|>`).
 * Delivery tags (emotion, style, prosody speed / pitch / expressive) set how a whole request is
 * spoken, so a text that changes delivery midway is split into parts, one model request each.
 * Positional tags (prosody pause / long_pause, sfx) work where they are and stay inside their part.
 * ---------------------------------------------------------------------------------------------- */

export const TTS_STYLES = ["singing", "shouting", "whispering"] as const;
export const TTS_PROSODY_DELIVERY = [
  "speed_very_slow",
  "speed_slow",
  "speed_fast",
  "speed_very_fast",
  "pitch_low",
  "pitch_high",
  "expressive_high",
  "expressive_low",
] as const;
export const TTS_PROSODY_INLINE = ["pause", "long_pause"] as const;
export const TTS_SFX = [
  "cough",
  "laughter",
  "crying",
  "screaming",
  "burping",
  "humming",
  "sigh",
  "sniff",
  "sneeze",
] as const;

const KNOWN_TAG_VALUES: Record<string, readonly string[]> = {
  emotion: TTS_EMOTIONS,
  style: TTS_STYLES,
  prosody: [...TTS_PROSODY_DELIVERY, ...TTS_PROSODY_INLINE],
  sfx: TTS_SFX,
};

const ANY_TAG_RE = /<\|([^<>|]*)\|>/g;

/** Every `<|…|>` in the text that the model does not know, e.g. `<|emotion:happy|>`. */
export const findInvalidTags = (text: string): string[] => {
  const invalid = new Set<string>();
  for (const match of text.matchAll(ANY_TAG_RE)) {
    const [category, value, ...rest] = (match[1] ?? "").split(":");
    const known = category ? KNOWN_TAG_VALUES[category] : undefined;
    if (rest.length || !known || !value || !known.includes(value)) invalid.add(match[0]);
  }
  return [...invalid];
};

export const invalidTagMessage = (tags: string[]) =>
  `Unknown control tag${tags.length > 1 ? "s" : ""}: ${tags.join(", ")}. ` +
  "Use <|emotion:NAME|>, <|style:NAME|>, <|prosody:NAME|> or <|sfx:NAME|> with a supported name " +
  "(see styleTags in GET /tts/options).";

/** Delivery slot a tag occupies; a new tag replaces the previous one in the same slot. */
type DeliverySlot = "emotion" | "style" | "speed" | "pitch" | "expressive";
const SLOT_ORDER: DeliverySlot[] = ["emotion", "style", "speed", "pitch", "expressive"];

const deliverySlot = (category: string, value: string): DeliverySlot | null => {
  if (category === "emotion" && isTtsEmotion(value)) return "emotion";
  if (category === "style" && (TTS_STYLES as readonly string[]).includes(value)) return "style";
  if (category === "prosody" && (TTS_PROSODY_DELIVERY as readonly string[]).includes(value)) {
    return value.split("_")[0] as DeliverySlot;
  }
  return null;
};

export type DeliveryPart = {
  /** Delivery tags in force for this part, e.g. `<|emotion:anger|><|style:whispering|>`. */
  delivery: string;
  /** The words of this part, with any positional tags (pause, sfx) still inline. */
  text: string;
};

/** True when a piece of text has something to say, not just spaces, punctuation or positional tags. */
const hasSpeech = (text: string) => /[\p{L}\p{N}]/u.test(text.replace(ANY_TAG_RE, ""));

export const ttsMaxDeliveryParts = () => {
  const value = Number(process.env.TTS_MAX_DELIVERY_PARTS);
  return Number.isInteger(value) && value >= 1 ? value : 8;
};

/**
 * Splits text at every delivery tag. Each part carries all delivery tags in force at its start:
 * a new emotion replaces the previous emotion, while an earlier style (or speed, pitch, expressive)
 * stays on. Tags in a row count as one switch; a stretch with nothing to say is folded into its
 * neighbour. `baseEmotion` (the request's `emotion` field) is the starting emotion.
 * Beyond `TTS_MAX_DELIVERY_PARTS`, the rest of the text joins the last allowed part.
 */
export const splitIntoDeliveryParts = (
  text: string,
  baseEmotion?: string | null,
): DeliveryPart[] => {
  const active = new Map<DeliverySlot, string>();
  if (baseEmotion && isTtsEmotion(baseEmotion)) active.set("emotion", `<|emotion:${baseEmotion}|>`);
  const deliveryNow = () =>
    SLOT_ORDER.map((slot) => active.get(slot)).filter(Boolean).join("");

  const parts: DeliveryPart[] = [];
  let body = "";
  let bodyDelivery = deliveryNow();
  let last = 0;

  for (const match of text.matchAll(ANY_TAG_RE)) {
    const [category = "", value = ""] = (match[1] ?? "").split(":");
    const slot = deliverySlot(category, value);
    if (!slot) continue; // positional or unknown tag: stays in the text

    body += text.slice(last, match.index);
    last = match.index! + match[0].length;
    if (hasSpeech(body)) {
      parts.push({ delivery: bodyDelivery, text: body.trim() });
      body = "";
    }
    // Text with nothing to say yet (spaces, punctuation, a pause) moves on with the new delivery.
    active.set(slot, match[0]);
    bodyDelivery = deliveryNow();
  }
  body += text.slice(last);
  if (hasSpeech(body) || !parts.length) {
    parts.push({ delivery: bodyDelivery, text: body.trim() });
  } else if (body.trim()) {
    parts[parts.length - 1]!.text += body.trimEnd();
  }

  const max = ttsMaxDeliveryParts();
  if (parts.length > max) {
    const kept = parts.slice(0, max);
    kept[max - 1]!.text = [kept[max - 1]!.text, ...parts.slice(max).map((part) => part.text)].join(" ");
    console.warn(`TTS text has ${parts.length} delivery changes; only the first ${max} are applied`);
    return kept;
  }
  return parts;
};
