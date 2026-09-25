import { pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", [
  "user",
  "admin",
  "superAdmin",
  "tenant",
]);

export const otpPurposeEnum = pgEnum("otp_purpose", [
  "signup",
  "login",
  "password_reset",
]);

export const ttsGenerationStatusEnum = pgEnum("tts_generation_status", [
  "queued",
  "processing",
  "completed",
  "failed",
]);

export const ttsVoiceModeEnum = pgEnum("tts_voice_mode", [
  "default",
  "clone",
]);

export const ttsAudioFormatEnum = pgEnum("tts_audio_format", [
  "wav",
  "mp3",
  "ogg",
]);
