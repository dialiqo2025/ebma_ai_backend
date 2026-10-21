import { date, index, integer, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

/** One durable execution record per local calendar day. */
export const DailyUserReports = pgTable(
  "daily_user_reports",
  {
    report_date: date("report_date", { mode: "string" }).primaryKey(),
    window_start: timestamp("window_start", { mode: "date" }).notNull(),
    window_end: timestamp("window_end", { mode: "date" }).notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull(),
    recipient: varchar("recipient", { length: 320 }).notNull(),
    status: varchar("status", { length: 20 }).default("processing").notNull(),
    row_count: integer("row_count").default(0).notNull(),
    provider_message_id: varchar("provider_message_id", { length: 255 }),
    error_message: text("error_message"),
    started_at: timestamp("started_at", { mode: "date" }).defaultNow().notNull(),
    sent_at: timestamp("sent_at", { mode: "date" }),
    updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("daily_user_reports_status_idx").on(table.status)],
);
