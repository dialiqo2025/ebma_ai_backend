import { index, pgTable, timestamp, uuid, varchar, text, uniqueIndex } from "drizzle-orm/pg-core";
import { Users } from "./user.schema";

export const Projects = pgTable("projects", {
  project_uuid: uuid("project_uuid").defaultRandom().primaryKey(),
  user_uuid: uuid("user_uuid").notNull().references(() => Users.user_uuid, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  created_at: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => [
  index("projects_user_created_idx").on(table.user_uuid, table.created_at),
  index("projects_user_status_idx").on(table.user_uuid, table.status),
  uniqueIndex("projects_user_name_unique").on(table.user_uuid, table.name),
]);
