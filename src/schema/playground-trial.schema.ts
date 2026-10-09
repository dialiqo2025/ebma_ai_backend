import {
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** Anonymous website playground usage, keyed by hashed client IP + API. */
export const PlaygroundTrials = pgTable(
  "playground_trials",
  {
    trial_uuid: uuid("trial_uuid").defaultRandom().primaryKey(),
    ip_hash: varchar("ip_hash", { length: 64 }).notNull(),
    api: varchar("api", { length: 16 }).notNull(),
    use_count: integer("use_count").default(0).notNull(),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => ({
    ipApiUniq: uniqueIndex("playground_trials_ip_api_uniq").on(
      table.ip_hash,
      table.api,
    ),
    ipIdx: index("playground_trials_ip_idx").on(table.ip_hash),
  }),
);
