import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { Users } from "./user.schema";

export type VoiceBotWebhookTool = {
  name: string;
  description: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string> | undefined;
};

export const VoiceBots = pgTable(
  "voice_bots",
  {
    bot_uuid: uuid("bot_uuid").defaultRandom().primaryKey(),
    user_uuid: uuid("user_uuid")
      .notNull()
      .references(() => Users.user_uuid, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    system_prompt: text("system_prompt").notNull(),
    greeting: text("greeting").default("").notNull(),
    language: varchar("language", { length: 8 }).default("hi").notNull(),
    stt_mode: varchar("stt_mode", { length: 16 }).default("native").notNull(),
    end_silence_ms: integer("end_silence_ms").default(700).notNull(),
    voice_mode: varchar("voice_mode", { length: 16 }).default("default").notNull(),
    voice_id: varchar("voice_id", { length: 255 }),
    speed: real("speed").default(1).notNull(),
    pitch: real("pitch").default(1).notNull(),
    temperature: real("temperature").default(0.4).notNull(),
    barge_in: boolean("barge_in").default(true).notNull(),
    silence_timeout_s: integer("silence_timeout_s").default(15).notNull(),
    max_duration_s: integer("max_duration_s").default(600).notNull(),
    handoff_enabled: boolean("handoff_enabled").default(true).notNull(),
    handoff_message: text("handoff_message").default("").notNull(),
    goodbye_message: text("goodbye_message").default("").notNull(),
    tools: jsonb("tools").$type<VoiceBotWebhookTool[]>().default([]).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("voice_bots_user_idx").on(table.user_uuid)],
);

/** Credentials a call center uses to stream calls into this account's bots. */
export const VoiceBotConnections = pgTable(
  "voice_bot_connections",
  {
    connection_uuid: uuid("connection_uuid").defaultRandom().primaryKey(),
    user_uuid: uuid("user_uuid")
      .notNull()
      .references(() => Users.user_uuid, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    token_prefix: varchar("token_prefix", { length: 24 }).notNull(),
    token_hash: varchar("token_hash", { length: 64 }).notNull().unique(),
    allowed_ips: jsonb("allowed_ips").$type<string[]>().default([]).notNull(),
    /** Call center control API (handoff / hangup / break), e.g. https://talkify/api/ai-bot */
    callback_url: varchar("callback_url", { length: 500 }),
    callback_token: varchar("callback_token", { length: 255 }),
    /** "json" = mod_audio_stream streamAudio messages, "binary" = raw L16 frames back. */
    playback_mode: varchar("playback_mode", { length: 16 }).default("json").notNull(),
    sample_rate: integer("sample_rate").default(16000).notNull(),
    revoked_at: timestamp("revoked_at", { mode: "date" }),
    last_used_at: timestamp("last_used_at", { mode: "date" }),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("voice_bot_connections_user_idx").on(table.user_uuid)],
);

export const VoiceCalls = pgTable(
  "voice_calls",
  {
    call_uuid: uuid("call_uuid").defaultRandom().primaryKey(),
    user_uuid: uuid("user_uuid")
      .notNull()
      .references(() => Users.user_uuid, { onDelete: "cascade" }),
    bot_uuid: uuid("bot_uuid").references(() => VoiceBots.bot_uuid, { onDelete: "set null" }),
    connection_uuid: uuid("connection_uuid").references(() => VoiceBotConnections.connection_uuid, { onDelete: "set null" }),
    /** Call id on the call center side (FreeSWITCH channel uuid). */
    external_call_id: varchar("external_call_id", { length: 128 }),
    caller: varchar("caller", { length: 64 }),
    callee: varchar("callee", { length: 64 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    status: varchar("status", { length: 24 }).default("active").notNull(),
    end_reason: varchar("end_reason", { length: 48 }),
    summary: text("summary"),
    handoff_target: varchar("handoff_target", { length: 255 }),
    duration_seconds: real("duration_seconds").default(0).notNull(),
    started_at: timestamp("started_at", { mode: "date" }).defaultNow().notNull(),
    ended_at: timestamp("ended_at", { mode: "date" }),
  },
  (table) => [
    index("voice_calls_user_started_idx").on(table.user_uuid, table.started_at),
    index("voice_calls_external_idx").on(table.external_call_id),
  ],
);

export const VoiceCallTurns = pgTable(
  "voice_call_turns",
  {
    turn_uuid: uuid("turn_uuid").defaultRandom().primaryKey(),
    call_uuid: uuid("call_uuid")
      .notNull()
      .references(() => VoiceCalls.call_uuid, { onDelete: "cascade" }),
    turn_index: integer("turn_index").notNull(),
    role: varchar("role", { length: 16 }).notNull(),
    text: text("text").notNull(),
    interrupted: boolean("interrupted").default(false).notNull(),
    /** User turn: ASR latency. Bot turn: end of user speech → first audio byte sent. */
    latency_ms: integer("latency_ms"),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("voice_call_turns_call_index_unique").on(table.call_uuid, table.turn_index)],
);
