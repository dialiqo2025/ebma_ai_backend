export const TTS_VOICE_PRESET_IDS = ["violet", "indigo", "aurora", "ember"] as const;
export type TtsVoicePresetId = (typeof TTS_VOICE_PRESET_IDS)[number];

export const DEFAULT_TTS_VOICE_PRESET: TtsVoicePresetId = "violet";

const presets: Array<{
  id: TtsVoicePresetId;
  name: string;
  description: string;
  seed: number;
}> = [
  { id: "violet", name: "Violet", description: "System voice preset 01", seed: 42 },
  { id: "indigo", name: "Indigo", description: "System voice preset 02", seed: 108 },
  { id: "aurora", name: "Aurora", description: "System voice preset 03", seed: 256 },
  { id: "ember", name: "Ember", description: "System voice preset 04", seed: 512 },
];

export const getTtsVoicePreset = (id: string | null | undefined) =>
  presets.find((preset) => preset.id === id) ?? presets.find((preset) => preset.id === DEFAULT_TTS_VOICE_PRESET)!;

export const publicTtsVoicePresets = () => presets.map(({ seed: _seed, ...preset }) => ({
  ...preset,
  previewUrl: `/api/v1/tts/voice-presets/${preset.id}/preview`,
}));

const previewText: Record<string, string> = {
  hi: "नमस्ते, यह आपकी चुनी हुई आवाज़ का एक छोटा सा नमूना है।",
  en: "Hello, this is a short preview of your selected voice.",
  ta: "வணக்கம், இது நீங்கள் தேர்ந்தெடுத்த குரலின் சிறிய முன்னோட்டம்.",
  bn: "নমস্কার, এটি আপনার নির্বাচিত কণ্ঠের একটি ছোট নমুনা।",
  te: "నమస్కారం, ఇది మీరు ఎంచుకున్న స్వరానికి చిన్న నమూనా.",
  mr: "नमस्कार, हा तुम्ही निवडलेल्या आवाजाचा एक छोटा नमुना आहे.",
  gu: "નમસ્તે, આ તમે પસંદ કરેલા અવાજનો નાનો નમૂનો છે.",
  kn: "ನಮಸ್ಕಾರ, ಇದು ನೀವು ಆಯ್ಕೆ ಮಾಡಿದ ಧ್ವನಿಯ ಚಿಕ್ಕ ಮುನ್ನೋಟ.",
  ml: "നമസ്കാരം, ഇത് നിങ്ങൾ തിരഞ്ഞെടുത്ത ശബ്ദത്തിന്റെ ചെറിയ മാതൃകയാണ്.",
  pa: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਇਹ ਤੁਹਾਡੀ ਚੁਣੀ ਹੋਈ ਆਵਾਜ਼ ਦਾ ਛੋਟਾ ਨਮੂਨਾ ਹੈ।",
};

export const ttsVoicePresetPreviewText = (language: string) => ({
  language: previewText[language] ? language : "en",
  text: previewText[language] ?? previewText.en!,
});

