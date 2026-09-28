export const STT_LANGUAGES = [
  { code: "auto", name: "Automatic detection" },
  { code: "hi", name: "Hindi" },
  { code: "bn", name: "Bengali" },
  { code: "ta", name: "Tamil" },
  { code: "te", name: "Telugu" },
  { code: "mr", name: "Marathi" },
  { code: "gu", name: "Gujarati" },
  { code: "kn", name: "Kannada" },
  { code: "ml", name: "Malayalam" },
  { code: "pa", name: "Punjabi" },
  { code: "or", name: "Odia" },
  { code: "ur", name: "Urdu" },
  { code: "as", name: "Assamese" },
  { code: "ne", name: "Nepali" },
  { code: "sa", name: "Sanskrit" },
  { code: "sd", name: "Sindhi" },
  { code: "ks", name: "Kashmiri" },
  { code: "kok", name: "Konkani" },
  { code: "mai", name: "Maithili" },
  { code: "doi", name: "Dogri" },
  { code: "brx", name: "Bodo" },
  { code: "mni", name: "Manipuri" },
  { code: "sat", name: "Santali" },
  { code: "bho", name: "Bhojpuri" },
  { code: "hne", name: "Chhattisgarhi" },
  { code: "bgc", name: "Haryanvi" },
  { code: "bhb", name: "Bhili" },
  { code: "en", name: "English (Indian)" },
] as const;

export const isSttModelConfigured = () =>
  Boolean(
    process.env.EBMA_ASR_BACKEND_URL?.trim() && process.env.EBMA_ASR_API_KEY?.trim(),
  );

export const serializeSttSegment = (segment: any) => ({
  segmentUuid: segment.segment_uuid,
  seg: segment.segment_index,
  text: segment.text,
  lang: segment.language,
  t0: segment.start_seconds,
  t1: segment.end_seconds,
  audio_s: segment.audio_seconds,
  decode_ms: segment.decode_ms,
  latency_ms: segment.latency_ms,
  reason: segment.reason,
  createdAt: segment.created_at,
});

export const serializeSttSession = (session: any, segments?: any[]) => ({
  sessionUuid: session.session_uuid,
  language: session.language,
  mode: session.output_mode,
  sampleRate: session.sample_rate,
  endSilenceMs: session.end_silence_ms,
  partials: session.partials,
  status: session.status,
  transcript: session.transcript,
  phraseCount: session.phrase_count,
  audioDurationSeconds: session.audio_duration_seconds,
  error:
    session.error_code || session.error_message
      ? { code: session.error_code, message: session.error_message }
      : null,
  startedAt: session.started_at,
  completedAt: session.completed_at,
  createdAt: session.created_at,
  updatedAt: session.updated_at,
  ...(segments ? { segments: segments.map(serializeSttSegment) } : {}),
});

export const toSttStartMessage = (session: any) => ({
  type: "start" as const,
  sample_rate: session.sample_rate,
  lang: session.language,
  mode: session.output_mode,
  end_silence_ms: session.end_silence_ms,
  partials: session.partials,
});

export const mapProviderTranscriptionStatus = (
  status: unknown,
): "queued" | "processing" | "completed" | "failed" | "cancelled" => {
  switch (String(status || "").toLowerCase()) {
    case "done":
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "processing":
    case "running":
      return "processing";
    case "queued":
    default:
      return "queued";
  }
};

export const serializeSttTranscription = (row: any) => ({
  transcriptionUuid: row.transcription_uuid,
  providerJobId: row.provider_job_id,
  filename: row.original_filename,
  contentType: row.content_type,
  fileSizeBytes: row.file_size_bytes,
  language: row.language,
  diarize: row.diarize,
  speakers: row.speakers,
  status: row.status,
  stage: row.stage,
  progress: row.progress,
  audioSeconds: row.audio_seconds,
  transcript: row.transcript,
  result: row.result_json ?? null,
  error:
    row.error_code || row.error_message
      ? { code: row.error_code, message: row.error_message }
      : null,
  completedAt: row.completed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const maxUploadBytes = () => {
  const configured = Number(process.env.STT_MAX_UPLOAD_BYTES);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : 300 * 1024 * 1024;
};
