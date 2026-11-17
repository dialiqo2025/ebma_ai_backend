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
