import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { Users } from "./user.schema";

export const GpuHealthMonitorSettings = pgTable("gpu_health_monitor_settings", {
  setting_id: integer("setting_id").primaryKey().default(1),
  enabled: boolean("enabled").default(true).notNull(),
  check_interval_minutes: integer("check_interval_minutes").default(30).notNull(),
  retention_days: integer("retention_days").default(30).notNull(),
  notifications_enabled: boolean("notifications_enabled").default(true).notNull(),
  notify_healthy: boolean("notify_healthy").default(false).notNull(),
  notify_high_usage: boolean("notify_high_usage").default(true).notNull(),
  notify_unhealthy: boolean("notify_unhealthy").default(true).notNull(),
  notify_recovered: boolean("notify_recovered").default(false).notNull(),
  high_usage_threshold_percent: integer("high_usage_threshold_percent").default(80).notNull(),
  repeat_alert_minutes: integer("repeat_alert_minutes").default(60).notNull(),
  next_check_at: timestamp("next_check_at", { mode: "date" }).defaultNow().notNull(),
  last_check_at: timestamp("last_check_at", { mode: "date" }),
  updated_by: uuid("updated_by").references(() => Users.user_uuid, { onDelete: "set null" }),
  updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});

export const GpuHealthRecipients = pgTable(
  "gpu_health_recipients",
  {
    recipient_uuid: uuid("recipient_uuid").defaultRandom().primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    created_by: uuid("created_by").references(() => Users.user_uuid, { onDelete: "set null" }),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("gpu_health_recipients_email_idx").on(table.email)],
);

export const GpuHealthCheckLogs = pgTable(
  "gpu_health_check_logs",
  {
    check_uuid: uuid("check_uuid").defaultRandom().primaryKey(),
    trigger: varchar("trigger", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    context: varchar("context", { length: 32 }).notNull(),
    endpoint: varchar("endpoint", { length: 1000 }).notNull(),
    method: varchar("method", { length: 8 }).notNull(),
    http_status: integer("http_status"),
    duration_ms: integer("duration_ms").notNull(),
    response_body: text("response_body"),
    error_code: varchar("error_code", { length: 100 }),
    error_message: text("error_message"),
    usage_percent: integer("usage_percent"),
    active_workload: integer("active_workload"),
    capacity: integer("capacity"),
    queue_depth: integer("queue_depth"),
    notification_status: varchar("notification_status", { length: 24 }).default("not_requested").notNull(),
    notification_recipient_count: integer("notification_recipient_count").default(0).notNull(),
    notification_error: text("notification_error"),
    checked_at: timestamp("checked_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("gpu_health_check_logs_checked_idx").on(table.checked_at),
    index("gpu_health_check_logs_status_checked_idx").on(table.status, table.checked_at),
  ],
);
