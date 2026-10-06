import crypto from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import { loadPrivateUserConfig } from "../llm/llm.user.provider";
import { LlmModelError, requestLlmCompletion } from "../llm/llm.model";
import { TRANSLATE_LANGUAGES, type DocumentTranslationInput, type TranslateTextInput } from "./translate.validate";

const outputDirectory = path.resolve(process.env.TRANSLATE_OUTPUT_DIRECTORY || path.join(process.cwd(), "storage", "translations"));
const secret = () => process.env.JWT_SECRET_KEY || "";
const jobSignature = (userUuid: string, jobId: string) => crypto.createHmac("sha256", secret()).update(`${userUuid}:${jobId}`).digest("base64url");
const signedJobId = (userUuid: string, jobId: string) => `${Buffer.from(jobId).toString("base64url")}.${jobSignature(userUuid, jobId)}`;

const verifyJobId = (userUuid: string, token: string) => {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) throw new Error("Invalid document translation job");
  const jobId = Buffer.from(encoded, "base64url").toString("utf8");
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("Invalid document translation job");
  const expected = Buffer.from(jobSignature(userUuid, jobId));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error("Document job does not belong to this account");
  return jobId;
};

const manifestPath = (jobId: string) => path.join(outputDirectory, jobId, "job.json");
const outputPath = (jobId: string, language: string) => path.join(outputDirectory, jobId, `${language}.txt`);
type LocalJob = { userUuid: string; jobName: string; sourceLanguageCode: string; targetLanguageCodes: string[]; createdAt: string };

const readJob = async (jobId: string, userUuid: string) => {
  const job = JSON.parse(await readFile(manifestPath(jobId), "utf8")) as LocalJob;
  if (job.userUuid !== userUuid) throw new Error("Document job does not belong to this account");
  return job;
};

const translate = async (userUuid: string, text: string, sourceCode: string, targetCode: string, input: { mode?: string; output_script?: string; numerals_format?: string; speaker_gender?: string; genre?: string; style_guidelines?: string } = {}) => {
  const sourceName = sourceCode === "auto" ? "the detected source language" : TRANSLATE_LANGUAGES.find((item) => item.code === sourceCode)?.name || sourceCode;
  const targetName = TRANSLATE_LANGUAGES.find((item) => item.code === targetCode)?.name || targetCode;
  const settings = await loadPrivateUserConfig(userUuid);
  if (!settings || settings.provider.toLowerCase() !== "custom" || !settings.endpoint?.trim()) {
    throw new LlmModelError("Configure a self-hosted Custom model endpoint in LLM settings to use translation. Translation does not fall back to a paid provider.", "self_hosted_model_required", 503);
  }
  const system = [
    "You are EBMA's translation engine. Translate faithfully and naturally without adding facts.",
    `Translate from ${sourceName} to ${targetName} (locale ${targetCode}).`,
    `Style: ${input.mode || "formal"}.`,
    input.genre ? `Document genre: ${input.genre.replaceAll("_", " ").toLowerCase()}.` : "",
    input.style_guidelines ? `Additional translation guidance: ${input.style_guidelines}` : "",
    input.output_script ? `Write using the ${input.output_script} script preference.` : "Use the target language's standard native writing system.",
    `Numerals: ${input.numerals_format || "international"}.`,
    input.speaker_gender ? `When the target language requires grammatical speaker gender, use ${input.speaker_gender.toLowerCase()}.` : "",
    "Preserve paragraph breaks, names, numbers, and meaning. Return only the translated text; do not explain or add markdown.",
  ].filter(Boolean).join("\n");
  const result = await requestLlmCompletion({ system, turns: [{ role: "user", text }], temperature: 0.2 }, settings);
  const translatedText = result.rawText.trim();
  if (!translatedText) throw new LlmModelError("The translation model returned empty text", "invalid_model_response", 502);
  return { translatedText, requestId: result.providerRequestId };
};

export const getTranslateOptions = () => {
  return GenResObj(Code.OK, true, "Translation options fetched", {
    languages: TRANSLATE_LANGUAGES,
    models: ["EBMA self-hosted model"],
    modes: ["formal", "classic-colloquial", "modern-colloquial", "code-mixed"],
    outputScripts: ["default", "roman", "fully-native", "spoken-form-in-native"],
    numeralsFormats: ["international", "native"],
    speakerGenders: ["unset", "Male", "Female"],
    documentFormats: ["txt", "md", "csv"],
  });
};

export const translateText = async (userUuid: string, input: TranslateTextInput) => {
  let failurePhase = "loading your LLM configuration";
  try {
    failurePhase = "calling your self-hosted translation model";
    const result = await translate(userUuid, input.input, input.source_language_code, input.target_language_code, {
      mode: input.mode,
      numerals_format: input.numerals_format,
      ...(input.output_script ? { output_script: input.output_script } : {}),
      ...(input.speaker_gender ? { speaker_gender: input.speaker_gender } : {}),
    });
    return GenResObj(Code.OK, true, "Text translated", {
      requestId: result.requestId ?? null,
      translatedText: result.translatedText,
      sourceLanguageCode: input.source_language_code,
      targetLanguageCode: input.target_language_code,
      model: "EBMA LLM",
      characters: input.input.length,
    });
  } catch (error) {
    if (!(error instanceof LlmModelError)) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`Unexpected translate error while ${failurePhase}: ${detail}`);
    }
    const failure = error instanceof LlmModelError
      ? error
      : new LlmModelError(`Unexpected error while ${failurePhase}. Check the backend logs for details.`, "translation_internal_error", 502);
    return GenResObj(failure.httpStatus, false, failure.message, { code: failure.code });
  }
};

export const createDocumentTranslation = async (userUuid: string, file: Express.Multer.File | undefined, input: DocumentTranslationInput) => {
  if (!file) return GenResObj(Code.BAD_REQUEST, false, "Choose a document to translate");
  const extension = path.extname(file.originalname).slice(1).toLowerCase();
  if (!["txt", "md", "csv"].includes(extension)) return GenResObj(Code.UNSUPPORTED_MEDIA_TYPE, false, "Local document translation currently supports plain text, Markdown, and CSV files.");
  const sourceText = file.buffer.toString("utf8");
  if (!sourceText.trim() || sourceText.length > 100_000) return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "Choose a non-empty text document under 100,000 characters.");
  const jobId = randomUUID();
  try {
    const directory = path.join(outputDirectory, jobId);
    await mkdir(directory, { recursive: true });
    const job: LocalJob = { userUuid, jobName: input.job_name || file.originalname, sourceLanguageCode: input.source_language_code, targetLanguageCodes: input.target_language_codes, createdAt: new Date().toISOString() };
    await writeFile(manifestPath(jobId), JSON.stringify(job), "utf8");
    for (const targetCode of input.target_language_codes) {
      const { translatedText } = await translate(userUuid, sourceText, input.source_language_code, targetCode, {
        mode: "formal",
        numerals_format: input.use_native_numerals ? "native" : "international",
        ...(input.genre ? { genre: input.genre } : {}),
        ...(input.style_guidelines ? { style_guidelines: input.style_guidelines } : {}),
      });
      await writeFile(outputPath(jobId, targetCode), translatedText, "utf8");
    }
    return GenResObj(Code.ACCEPTED, true, "Document translated", {
      jobToken: signedJobId(userUuid, jobId), jobName: job.jobName,
      targetLanguageCodes: job.targetLanguageCodes, jobState: "Completed", progress: 100,
    });
  } catch (error) {
    const failure = error instanceof LlmModelError ? error : new LlmModelError("Could not translate document", "document_translation_failed", 502);
    return GenResObj(failure.httpStatus, false, failure.message, { code: failure.code });
  }
};

export const getDocumentStatus = async (userUuid: string, token: string) => {
  try {
    const job = await readJob(verifyJobId(userUuid, token), userUuid);
    return GenResObj(Code.OK, true, "Document translation status", {
      job_state: "Completed", progress: 100,
      translations: job.targetLanguageCodes.map((target_language_code) => ({ target_language_code, state: "Completed" })),
    });
  } catch (error) {
    return GenResObj(Code.NOT_FOUND, false, error instanceof Error ? error.message : "Document translation job not found");
  }
};

export const triggerDocumentExport = async (userUuid: string, token: string, language: string) => {
  try {
    const jobId = verifyJobId(userUuid, token);
    const job = await readJob(jobId, userUuid);
    if (!job.targetLanguageCodes.includes(language)) return GenResObj(Code.BAD_REQUEST, false, "This language is not part of the translation job");
    const file = outputPath(jobId, language);
    await readFile(file);
    return GenResObj(Code.OK, true, "Translated file is ready", { export_state: "Completed", download_url: `/translate/documents/${encodeURIComponent(token)}/export/${encodeURIComponent(language)}/download`, filename: `${path.parse(job.jobName).name}-${language}.txt` });
  } catch (error) {
    return GenResObj(Code.NOT_FOUND, false, error instanceof Error ? error.message : "Translated file not found");
  }
};

export const getDocumentExportStatus = triggerDocumentExport;

export const getDocumentExportFile = async (userUuid: string, token: string, language: string) => {
  try {
    const jobId = verifyJobId(userUuid, token);
    const job = await readJob(jobId, userUuid);
    if (!job.targetLanguageCodes.includes(language)) return null;
    await readFile(outputPath(jobId, language));
    return { path: outputPath(jobId, language), filename: `${path.parse(job.jobName).name}-${language}.txt` };
  } catch {
    return null;
  }
};
