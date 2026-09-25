import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sttOutputModeEnum, sttSessionStatusEnum } from "./enums.schema";
import { Users } from "./user.schema";

export const SttSessions = pgTable(
  "stt_sessions",
  {
    session_uuid: uuid("session_uuid").defaultRandom().primaryKey(),
    user_uuid: uuid("user_uuid")
      .notNull()
      .references(() => Users.user_uuid, { onDelete: "cascade" }),
    language: varchar("language", { length: 8 }).default("hi").notNull(),
    output_mode: sttOutputModeEnum("output_mode").default("native").notNull(),
    sample_rate: integer("sample_rate").default(16000).notNull(),
    end_silence_ms: integer("end_silence_ms").default(700).notNull(),
    partials: boolean("partials").default(true).notNull(),
    status: sttSessionStatusEnum("status").default("created").notNull(),
    transcript: text("transcript").default("").notNull(),
    phrase_count: integer("phrase_count").default(0).notNull(),
    audio_duration_seconds: real("audio_duration_seconds").default(0).notNull(),
    error_code: varchar("error_code", { length: 100 }),
    error_message: text("error_message"),
    started_at: timestamp("started_at", { mode: "date" }),
    completed_at: timestamp("completed_at", { mode: "date" }),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("stt_sessions_user_created_idx").on(table.user_uuid, table.created_at),
    index("stt_sessions_user_status_idx").on(table.user_uuid, table.status),
  ],
);

export const SttSegments = pgTable(
  "stt_segments",
  {
    segment_uuid: uuid("segment_uuid").defaultRandom().primaryKey(),
    session_uuid: uuid("session_uuid")
      .notNull()
      .references(() => SttSessions.session_uuid, { onDelete: "cascade" }),
    segment_index: integer("segment_index").notNull(),
    text: text("text").notNull(),
    language: varchar("language", { length: 8 }).notNull(),
    start_seconds: real("start_seconds").notNull(),
    end_seconds: real("end_seconds").notNull(),
    audio_seconds: real("audio_seconds").notNull(),
    decode_ms: integer("decode_ms").notNull(),
    latency_ms: integer("latency_ms").notNull(),
    reason: varchar("reason", { length: 32 }).notNull(),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("stt_segments_session_index_unique").on(
      table.session_uuid,
      table.segment_index,
    ),
    index("stt_segments_session_created_idx").on(table.session_uuid, table.created_at),
  ],
);
