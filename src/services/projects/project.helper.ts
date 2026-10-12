import { and, desc, eq } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { Projects } from "../../schema";

export const ensureDefaultProject = async (userUuid: string) => {
  const [existing] = await db.select().from(Projects)
    .where(and(eq(Projects.user_uuid, userUuid), eq(Projects.name, "Default project")))
    .orderBy(desc(Projects.created_at)).limit(1);
  if (existing) return existing;

  await db.insert(Projects).values({
    user_uuid: userUuid,
    name: "Default project",
    description: "Your personal project for existing and ungrouped API usage.",
  }).onConflictDoNothing();

  const [created] = await db.select().from(Projects)
    .where(and(eq(Projects.user_uuid, userUuid), eq(Projects.name, "Default project")))
    .orderBy(desc(Projects.created_at)).limit(1);
  if (!created) throw new Error("Unable to initialize the default project");
  return created;
};
