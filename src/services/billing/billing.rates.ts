/** Default PAYG pair rates. 1 credit = ₹1. */
export const DEFAULT_RATE_PAIRS = {
  tts: { credits: 30, chars: 1000 },
  stt: { credits: 1, minutes: 1 },
  llm: { credits: 1, tokens: 1000 },
} as const;

export type PlanRateColumns = {
  tts_credits_per_1000_chars?: string | number | null;
  stt_credits_per_minute?: string | number | null;
  llm_credits_per_1000_tokens?: string | number | null;
  tts_rate_credits?: string | number | null;
  tts_rate_chars?: string | number | null;
  stt_rate_credits?: string | number | null;
  stt_rate_minutes?: string | number | null;
  llm_rate_credits?: string | number | null;
  llm_rate_tokens?: string | number | null;
};

export type ResolvedPlanRates = {
  tts: { credits: number; chars: number };
  stt: { credits: number; minutes: number };
  llm: { credits: number; tokens: number };
  /** Legacy-compatible normalized views (kept in sync for rollback). */
  ttsCreditsPer1000Chars: number;
  sttCreditsPerMinute: number;
  llmCreditsPer1000Tokens: number;
  unitPrices: {
    tts_characters: number;
    stt_seconds: number;
    llm_tokens: number;
  };
};

export type RateWriteInput = {
  ttsRateCredits?: number | null;
  ttsRateChars?: number | null;
  sttRateCredits?: number | null;
  sttRateMinutes?: number | null;
  llmRateCredits?: number | null;
  llmRateTokens?: number | null;
  ttsCreditsPer1000Chars?: number | null;
  sttCreditsPerMinute?: number | null;
  llmCreditsPer1000Tokens?: number | null;
};

const finiteOr = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const positiveOr = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const roundCredits = (value: number) => {
  if (!Number.isFinite(value) || value < 0) return 0;
  const at6 = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(at6, -0) ? 0 : at6;
};

export const normalizeRateString = (value: number | null | undefined) => {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return roundCredits(value).toFixed(6);
};

/** Resolve charging rates from plan columns. Prefers pair; falls back to legacy. */
export const resolveRatesFromPlan = (
  plan: PlanRateColumns | null | undefined,
): ResolvedPlanRates => {
  const ttsCredits = finiteOr(
    plan?.tts_rate_credits ?? plan?.tts_credits_per_1000_chars,
    DEFAULT_RATE_PAIRS.tts.credits,
  );
  const ttsChars = positiveOr(
    plan?.tts_rate_chars ?? (plan?.tts_credits_per_1000_chars != null ? 1000 : null),
    DEFAULT_RATE_PAIRS.tts.chars,
  );

  const sttCredits = finiteOr(
    plan?.stt_rate_credits ?? plan?.stt_credits_per_minute,
    DEFAULT_RATE_PAIRS.stt.credits,
  );
  const sttMinutes = positiveOr(
    plan?.stt_rate_minutes ?? (plan?.stt_credits_per_minute != null ? 1 : null),
    DEFAULT_RATE_PAIRS.stt.minutes,
  );

  const llmCredits = finiteOr(
    plan?.llm_rate_credits ?? plan?.llm_credits_per_1000_tokens,
    DEFAULT_RATE_PAIRS.llm.credits,
  );
  const llmTokens = positiveOr(
    plan?.llm_rate_tokens ?? (plan?.llm_credits_per_1000_tokens != null ? 1000 : null),
    DEFAULT_RATE_PAIRS.llm.tokens,
  );

  return {
    tts: { credits: roundCredits(ttsCredits), chars: roundCredits(ttsChars) },
    stt: { credits: roundCredits(sttCredits), minutes: roundCredits(sttMinutes) },
    llm: { credits: roundCredits(llmCredits), tokens: roundCredits(llmTokens) },
    ttsCreditsPer1000Chars: roundCredits((ttsCredits / ttsChars) * 1000),
    sttCreditsPerMinute: roundCredits(sttCredits / sttMinutes),
    llmCreditsPer1000Tokens: roundCredits((llmCredits / llmTokens) * 1000),
    unitPrices: {
      tts_characters: roundCredits(ttsCredits / ttsChars),
      stt_seconds: roundCredits(sttCredits / (sttMinutes * 60)),
      llm_tokens: roundCredits(llmCredits / llmTokens),
    },
  };
};

const resolveFamily = (
  input: RateWriteInput,
  existing: PlanRateColumns | null | undefined,
  family: "tts" | "stt" | "llm",
) => {
  if (family === "tts") {
    const hasPair =
      input.ttsRateCredits !== undefined || input.ttsRateChars !== undefined;
    const hasLegacy = input.ttsCreditsPer1000Chars !== undefined;
    if (hasPair) {
      return {
        credits: finiteOr(input.ttsRateCredits, DEFAULT_RATE_PAIRS.tts.credits),
        quantity: positiveOr(input.ttsRateChars, DEFAULT_RATE_PAIRS.tts.chars),
      };
    }
    if (hasLegacy) {
      return {
        credits: finiteOr(input.ttsCreditsPer1000Chars, DEFAULT_RATE_PAIRS.tts.credits),
        quantity: DEFAULT_RATE_PAIRS.tts.chars,
      };
    }
    const resolved = resolveRatesFromPlan(existing);
    return { credits: resolved.tts.credits, quantity: resolved.tts.chars };
  }

  if (family === "stt") {
    const hasPair =
      input.sttRateCredits !== undefined || input.sttRateMinutes !== undefined;
    const hasLegacy = input.sttCreditsPerMinute !== undefined;
    if (hasPair) {
      return {
        credits: finiteOr(input.sttRateCredits, DEFAULT_RATE_PAIRS.stt.credits),
        quantity: positiveOr(input.sttRateMinutes, DEFAULT_RATE_PAIRS.stt.minutes),
      };
    }
    if (hasLegacy) {
      return {
        credits: finiteOr(input.sttCreditsPerMinute, DEFAULT_RATE_PAIRS.stt.credits),
        quantity: DEFAULT_RATE_PAIRS.stt.minutes,
      };
    }
    const resolved = resolveRatesFromPlan(existing);
    return { credits: resolved.stt.credits, quantity: resolved.stt.minutes };
  }

  const hasPair =
    input.llmRateCredits !== undefined || input.llmRateTokens !== undefined;
  const hasLegacy = input.llmCreditsPer1000Tokens !== undefined;
  if (hasPair) {
    return {
      credits: finiteOr(input.llmRateCredits, DEFAULT_RATE_PAIRS.llm.credits),
      quantity: positiveOr(input.llmRateTokens, DEFAULT_RATE_PAIRS.llm.tokens),
    };
  }
  if (hasLegacy) {
    return {
      credits: finiteOr(input.llmCreditsPer1000Tokens, DEFAULT_RATE_PAIRS.llm.credits),
      quantity: DEFAULT_RATE_PAIRS.llm.tokens,
    };
  }
  const resolved = resolveRatesFromPlan(existing);
  return { credits: resolved.llm.credits, quantity: resolved.llm.tokens };
};

/**
 * Build DB column payload from either an explicit rate pair (preferred) or
 * legacy normalized fields. Always writes both pair + legacy columns.
 * Pass `existing` on updates so omitted families keep their current values.
 */
export const buildRateColumnValues = (
  input: RateWriteInput,
  existing?: PlanRateColumns | null,
) => {
  const tts = resolveFamily(input, existing, "tts");
  const stt = resolveFamily(input, existing, "stt");
  const llm = resolveFamily(input, existing, "llm");

  const ttsPer1000 = roundCredits((tts.credits / tts.quantity) * 1000);
  const sttPerMinute = roundCredits(stt.credits / stt.quantity);
  const llmPer1000 = roundCredits((llm.credits / llm.quantity) * 1000);

  return {
    tts_rate_credits: normalizeRateString(tts.credits),
    tts_rate_chars: normalizeRateString(tts.quantity),
    stt_rate_credits: normalizeRateString(stt.credits),
    stt_rate_minutes: normalizeRateString(stt.quantity),
    llm_rate_credits: normalizeRateString(llm.credits),
    llm_rate_tokens: normalizeRateString(llm.quantity),
    tts_credits_per_1000_chars: normalizeRateString(ttsPer1000),
    stt_credits_per_minute: normalizeRateString(sttPerMinute),
    llm_credits_per_1000_tokens: normalizeRateString(llmPer1000),
  };
};

export const formatRateExample = (
  credits: number,
  quantity: number,
  unitLabel: string,
) => {
  const qty = Number.isInteger(quantity)
    ? String(quantity)
    : String(roundCredits(quantity));
  return `₹${roundCredits(credits)} / ${qty} ${unitLabel}`;
};
