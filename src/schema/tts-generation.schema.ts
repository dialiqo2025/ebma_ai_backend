import {
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { Users } from "./user.schema";
import {
  ttsAudioFormatEnum,
  ttsGenerationStatusEnum,
  ttsVoiceModeEnum,
} from "./enums.schema";

export const TtsGenerations = pgTable("tts_generations", {
  generation_uuid: uuid("generation_uuid").defaultRandom().primaryKey(),
  user_uuid: uuid("user_uuid")
    .notNull()
    .references(() => Users.user_uuid, { onDelete: "cascade" }),
  input_text: text("input_text").notNull(),
  language: varchar("language", { length: 32 }).default("auto").notNull(),
  voice_mode: ttsVoiceModeEnum("voice_mode").default("default").notNull(),
  voice_id: varchar("voice_id", { length: 255 }),
  /** GPU emotion tag name (e.g. anger) — applied as `<|emotion:NAME|>` at synthesize time. */
  emotion: varchar("emotion", { length: 32 }),
  speed: real("speed").default(1).notNull(),
  pitch: real("pitch").default(1).notNull(),
  audio_format: ttsAudioFormatEnum("audio_format").default("wav").notNull(),
  status: ttsGenerationStatusEnum("status").default("queued").notNull(),
  audio_file_name: varchar("audio_file_name", { length: 255 }),
  audio_mime_type: varchar("audio_mime_type", { length: 100 }),
  audio_size_bytes: integer("audio_size_bytes"),
  provider_request_id: varchar("provider_request_id", { length: 255 }),
  error_code: varchar("error_code", { length: 100 }),
  error_message: text("error_message"),
  started_at: timestamp("started_at", { mode: "date" }),
  completed_at: timestamp("completed_at", { mode: "date" }),
  created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});
