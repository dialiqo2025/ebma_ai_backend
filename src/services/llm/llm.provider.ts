import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import { LlmModelError, transformWithLlm, type LlmStyle } from "./llm.model";
import { loadPrivateUserConfig } from "./llm.user.provider";

export type LlmProcessInput = {
  userUuid?: string;
  text: string;
  language: string;
  style?: LlmStyle;
  systemPrompt?: string;
};

export const processTranscriptWithLlm = async (input: LlmProcessInput) => {
  try {
    const result = await transformWithLlm(input, input.userUuid ? (await loadPrivateUserConfig(input.userUuid) ?? undefined) : undefined);

    return GenResObj(Code.OK, true, "Transcript processed successfully", {
      text: result.text,
      providerRequestId: result.providerRequestId,
    });
  } catch (error) {
    const modelError =
      error instanceof LlmModelError
        ? error
        : new LlmModelError("LLM processing failed", "processing_failed", 500);

    return GenResObj(modelError.httpStatus, false, modelError.message, {
      code: modelError.code,
    });
  }
};

export const prepareTextForTts = async (input: LlmProcessInput) => {
  const response = await processTranscriptWithLlm({
    ...input,
    style: input.style ?? "natural",
    systemPrompt:
      input.systemPrompt ??
      "Rewrite the transcript for a natural spoken voice. Remove filler noises and keep it polished but faithful.",
  });

  if (!response.data.success) {
    return response;
  }

  return GenResObj(Code.OK, true, "Text prepared for TTS", response.data.data);
};
