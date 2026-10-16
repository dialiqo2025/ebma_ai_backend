import { index, integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { Users } from "./user.schema";

export const TtsVoices = pgTable(
  "tts_voices",
  {
    voice_uuid: uuid("voice_uuid").defaultRandom().primaryKey(),
    user_uuid: uuid("user_uuid")
      .notNull()
      .references(() => Users.user_uuid, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    language: varchar("language", { length: 32 }).default("en").notNull(),
    description: varchar("description", { length: 280 }),
    reference_audio_file_name: varchar("reference_audio_file_name", { length: 255 }).notNull(),
    original_file_name: varchar("original_file_name", { length: 255 }),
    audio_mime_type: varchar("audio_mime_type", { length: 100 }),
    audio_size_bytes: integer("audio_size_bytes"),
    reference_text: text("reference_text"),
    consent_confirmed_at: timestamp("consent_confirmed_at", { mode: "date" }).notNull(),
    last_used_at: timestamp("last_used_at", { mode: "date" }),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("tts_voices_user_created_idx").on(table.user_uuid, table.created_at)],
);
