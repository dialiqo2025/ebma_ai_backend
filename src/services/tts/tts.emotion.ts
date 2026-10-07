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
  /** Emotion/style/speed colour the span they start; pause/sfx are point inserts. */
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
  {
    id: "speed-pitch",
    label: "SPEED AND PITCH",
    tags: (
      [
        ["speed-very-slow", "speed very slow", "<|speed:very_slow|>"],
        ["speed-slow", "speed slow", "<|speed:slow|>"],
        ["speed-fast", "speed fast", "<|speed:fast|>"],
        ["speed-very-fast", "speed very fast", "<|speed:very_fast|>"],
        ["pitch-low", "pitch low", "<|pitch:low|>"],
        ["pitch-high", "pitch high", "<|pitch:high|>"],
        ["expressive-high", "expressive high", "<|expressive:high|>"],
        ["expressive-low", "expressive low", "<|expressive:low|>"],
      ] as const
    ).map(([id, label, token]) => ({
      id,
      label,
      token,
      kind: "speed" as const,
    })),
  },
  {
    id: "pauses",
    label: "PAUSES",
    tags: (
      [
        ["pause", "pause", "<|pause|>"],
        ["long-pause", "long pause", "<|long_pause|>"],
      ] as const
    ).map(([id, label, token]) => ({
      id,
      label,
      token,
      kind: "pause" as const,
    })),
  },
  {
    id: "sfx",
    label: "SOUND EFFECTS",
    tags: (
      [
        "cough",
        "laughter",
        "crying",
        "screaming",
        "burping",
        "humming",
        "sigh",
        "sniff",
        "sneeze",
      ] as const
    ).map((name) => ({
      id: `sfx-${name}`,
      label: name,
      token: `<|${name}|>`,
      kind: "sfx" as const,
    })),
  },
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
