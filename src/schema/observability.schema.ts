import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { Users } from "./user.schema";
import { ApiKeys } from "./api-key.schema";

export const ApiTransactionLogs = pgTable(
  "api_transaction_logs",
  {
    log_uuid: uuid("log_uuid").defaultRandom().primaryKey(),
    request_id: uuid("request_id").notNull().unique(),
    user_uuid: uuid("user_uuid").references(() => Users.user_uuid, { onDelete: "set null" }),
    api_key_uuid: uuid("api_key_uuid").references(() => ApiKeys.key_uuid, { onDelete: "set null" }),
    method: varchar("method", { length: 12 }).notNull(),
    path: varchar("path", { length: 1000 }).notNull(),
    module: varchar("module", { length: 100 }).notNull(),
    functionality: varchar("functionality", { length: 255 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    http_status: integer("http_status").notNull(),
    description: text("description").notNull(),
    error_code: varchar("error_code", { length: 150 }),
    error_message: text("error_message"),
    request_metadata: jsonb("request_metadata"),
    response_metadata: jsonb("response_metadata"),
    ip_address: varchar("ip_address", { length: 128 }),
    user_agent: varchar("user_agent", { length: 1000 }),
    duration_ms: integer("duration_ms").notNull(),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("api_transaction_logs_created_idx").on(table.created_at),
    index("api_transaction_logs_status_created_idx").on(table.status, table.created_at),
    index("api_transaction_logs_user_created_idx").on(table.user_uuid, table.created_at),
    index("api_transaction_logs_module_created_idx").on(table.module, table.created_at),
  ],
);

export const GpuServiceLogs = pgTable(
  "gpu_service_logs",
  {
    log_uuid: uuid("log_uuid").defaultRandom().primaryKey(),
    request_id: uuid("request_id"),
    user_uuid: uuid("user_uuid").references(() => Users.user_uuid, { onDelete: "set null" }),
    api_key_uuid: uuid("api_key_uuid").references(() => ApiKeys.key_uuid, { onDelete: "set null" }),
    service: varchar("service", { length: 16 }).notNull(),
    operation: varchar("operation", { length: 100 }).notNull(),
    endpoint: varchar("endpoint", { length: 1000 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    upstream_status: integer("upstream_status"),
    description: text("description").notNull(),
    error_code: varchar("error_code", { length: 150 }),
    error_message: text("error_message"),
    provider_reference: varchar("provider_reference", { length: 255 }),
    request_metadata: jsonb("request_metadata"),
    response_metadata: jsonb("response_metadata"),
    artifact_file_name: varchar("artifact_file_name", { length: 255 }),
    artifact_original_name: varchar("artifact_original_name", { length: 512 }),
    artifact_content_type: varchar("artifact_content_type", { length: 255 }),
    duration_ms: integer("duration_ms").notNull(),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("gpu_service_logs_created_idx").on(table.created_at),
    index("gpu_service_logs_service_status_idx").on(table.service, table.status, table.created_at),
    index("gpu_service_logs_user_created_idx").on(table.user_uuid, table.created_at),
  ],
);

export const ObservabilitySettings = pgTable("observability_settings", {
  setting_id: integer("setting_id").primaryKey().default(1),
  retention_days: integer("retention_days").default(7).notNull(),
  updated_by: uuid("updated_by").references(() => Users.user_uuid, { onDelete: "set null" }),
  updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});
