import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sttTranscriptionStatusEnum } from "./enums.schema";
import { Users } from "./user.schema";

export const SttTranscriptions = pgTable(
  "stt_transcriptions",
  {
    transcription_uuid: uuid("transcription_uuid").defaultRandom().primaryKey(),
    user_uuid: uuid("user_uuid")
      .notNull()
      .references(() => Users.user_uuid, { onDelete: "cascade" }),
    provider_job_id: varchar("provider_job_id", { length: 255 }).notNull(),
    original_filename: varchar("original_filename", { length: 512 }).notNull(),
    content_type: varchar("content_type", { length: 255 }),
    file_size_bytes: integer("file_size_bytes"),
    language: varchar("language", { length: 8 }).default("hi").notNull(),
    diarize: boolean("diarize").default(false).notNull(),
    speakers: integer("speakers"),
    status: sttTranscriptionStatusEnum("status").default("queued").notNull(),
    stage: varchar("stage", { length: 64 }),
    progress: real("progress").default(0).notNull(),
    audio_seconds: real("audio_seconds"),
    transcript: text("transcript").default("").notNull(),
    result_json: jsonb("result_json"),
    error_code: varchar("error_code", { length: 100 }),
    error_message: text("error_message"),
    completed_at: timestamp("completed_at", { mode: "date" }),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("stt_transcriptions_user_created_idx").on(
      table.user_uuid,
      table.created_at,
    ),
    index("stt_transcriptions_user_status_idx").on(table.user_uuid, table.status),
    index("stt_transcriptions_provider_job_idx").on(table.provider_job_id),
  ],
);
