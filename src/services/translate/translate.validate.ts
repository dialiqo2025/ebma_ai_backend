import { z } from "zod";

export const TRANSLATE_LANGUAGES = [
  { code: "as-IN", name: "Assamese" },
  { code: "bn-IN", name: "Bengali" },
  { code: "brx-IN", name: "Bodo" },
  { code: "doi-IN", name: "Dogri" },
  { code: "en-IN", name: "English" },
  { code: "gu-IN", name: "Gujarati" },
  { code: "hi-IN", name: "Hindi" },
  { code: "kn-IN", name: "Kannada" },
  { code: "ks-IN", name: "Kashmiri" },
  { code: "kok-IN", name: "Konkani" },
  { code: "mai-IN", name: "Maithili" },
  { code: "ml-IN", name: "Malayalam" },
  { code: "mni-IN", name: "Manipuri" },
  { code: "mr-IN", name: "Marathi" },
  { code: "ne-IN", name: "Nepali" },
  { code: "or-IN", name: "Odia" },
  { code: "pa-IN", name: "Punjabi" },
  { code: "sa-IN", name: "Sanskrit" },
  { code: "sat-IN", name: "Santali" },
  { code: "sd-IN", name: "Sindhi" },
  { code: "ta-IN", name: "Tamil" },
  { code: "te-IN", name: "Telugu" },
  { code: "ur-IN", name: "Urdu" },
] as const;

const languageCodes = TRANSLATE_LANGUAGES.map((language) => language.code) as [string, ...string[]];
const model = z.literal("ebma-llm");

export const translateTextValidator = z.object({
  input: z.string().trim().min(1).max(2000),
  source_language_code: z.union([z.enum(languageCodes), z.literal("auto")]),
  target_language_code: z.enum(languageCodes),
  model: model.default("ebma-llm"),
  mode: z.enum(["formal", "classic-colloquial", "modern-colloquial", "code-mixed"]).default("formal"),
  output_script: z.enum(["roman", "fully-native", "spoken-form-in-native"]).optional(),
  numerals_format: z.enum(["international", "native"]).default("international"),
  speaker_gender: z.enum(["Male", "Female"]).optional(),
}).strict();

export const documentTranslationValidator = z.object({
  source_language_code: z.enum(languageCodes),
  target_language_codes: z.array(z.enum(languageCodes)).min(1).max(12),
  job_name: z.string().trim().max(255).optional(),
  genre: z.enum(["NON_FICTION", "ADULT_FICTION", "CHILDREN_FICTION", "RELIGIOUS", "LEGAL", "ACADEMIC"]).optional(),
  use_native_numerals: z.boolean().optional(),
  style_guidelines: z.string().max(4000).optional(),
}).strict().refine((value) => new Set(value.target_language_codes).size === value.target_language_codes.length, {
  path: ["target_language_codes"], message: "Choose each target language once",
});

export type TranslateTextInput = z.infer<typeof translateTextValidator>;
export type DocumentTranslationInput = z.infer<typeof documentTranslationValidator>;
