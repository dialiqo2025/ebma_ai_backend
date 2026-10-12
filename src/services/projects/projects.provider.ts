import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../../config/database/connection.database";
import { ApiKeys, BillingUsageLedger, Projects } from "../../schema";
import { GenResObj } from "../../utils/responseFormat.util";
import { HttpStatusCodes as Code } from "../../utils/httpType.util";
import { ensureDefaultProject } from "./project.helper";

const projectName = (input: unknown) => typeof input === "string" ? input.trim().replace(/\s+/g, " ").slice(0, 100) : "";
const projectDescription = (input: unknown) => typeof input === "string" ? input.trim().slice(0, 1000) : "";

export const listProjects = async (userUuid: string) => {
  await ensureDefaultProject(userUuid);
  const projects = await db.select().from(Projects)
    .where(eq(Projects.user_uuid, userUuid)).orderBy(desc(Projects.updated_at));
  const usage = await db.select({
    project_uuid: BillingUsageLedger.project_uuid,
    request_count: sql<number>`count(*)::int`,
    credits_used: sql<string>`coalesce(sum(${BillingUsageLedger.charged_credits}), 0)`,
  }).from(BillingUsageLedger)
    .where(eq(BillingUsageLedger.user_uuid, userUuid))
    .groupBy(BillingUsageLedger.project_uuid);
  const keys = await db.select({ project_uuid: ApiKeys.project_uuid, count: sql<number>`count(*)::int` })
    .from(ApiKeys).where(and(
      eq(ApiKeys.user_uuid, userUuid),
      sql`${ApiKeys.revoked_at} is null`,
      sql`(${ApiKeys.expires_at} is null or ${ApiKeys.expires_at} >= now())`,
    ))
    .groupBy(ApiKeys.project_uuid);
  const usageByProject = new Map(usage.map((row) => [row.project_uuid, row]));
  const keysByProject = new Map(keys.map((row) => [row.project_uuid, row.count]));
  return GenResObj(Code.OK, true, "Projects fetched successfully", projects.map((project) => ({
    ...project,
    request_count: Number(usageByProject.get(project.project_uuid)?.request_count ?? 0),
    credits_used: Number(usageByProject.get(project.project_uuid)?.credits_used ?? 0),
    active_keys: project.status === "active" ? Number(keysByProject.get(project.project_uuid) ?? 0) : 0,
  })));
};

export const createProject = async (userUuid: string, input: { name?: unknown; description?: unknown }) => {
  const name = projectName(input.name);
  if (!name) return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "Project name is required");
  if (name.toLowerCase() === "default project") return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "This name is reserved");
  try {
    const [project] = await db.insert(Projects).values({
      user_uuid: userUuid,
      name,
      description: projectDescription(input.description) || null,
    }).returning();
    return GenResObj(Code.CREATED, true, "Project created successfully", project);
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") return GenResObj(Code.CONFLICT, false, "A project with this name already exists");
    throw error;
  }
};

export const getProject = async (userUuid: string, projectUuid: string) => {
  const [project] = await db.select().from(Projects)
    .where(and(eq(Projects.project_uuid, projectUuid), eq(Projects.user_uuid, userUuid))).limit(1);
  if (!project) return GenResObj(Code.NOT_FOUND, false, "Project not found");

  const since = new Date(Date.now() - 29 * 86_400_000);
  const [totals] = await db.select({
    request_count: sql<number>`count(*)::int`,
    credits_used: sql<string>`coalesce(sum(${BillingUsageLedger.charged_credits}), 0)`,
    stt_requests: sql<number>`count(*) filter (where ${BillingUsageLedger.usage_type} = 'stt_seconds')::int`,
    tts_requests: sql<number>`count(*) filter (where ${BillingUsageLedger.usage_type} = 'tts_characters')::int`,
    assistant_requests: sql<number>`count(*) filter (where ${BillingUsageLedger.usage_type} = 'llm_tokens')::int`,
    stt_seconds: sql<string>`coalesce(sum(case when ${BillingUsageLedger.usage_type} = 'stt_seconds' then ${BillingUsageLedger.quantity} else 0 end), 0)`,
    tts_characters: sql<string>`coalesce(sum(case when ${BillingUsageLedger.usage_type} = 'tts_characters' then ${BillingUsageLedger.quantity} else 0 end), 0)`,
    assistant_tokens: sql<string>`coalesce(sum(case when ${BillingUsageLedger.usage_type} = 'llm_tokens' then ${BillingUsageLedger.quantity} else 0 end), 0)`,
  }).from(BillingUsageLedger).where(and(
    eq(BillingUsageLedger.user_uuid, userUuid),
    eq(BillingUsageLedger.project_uuid, projectUuid),
    gte(BillingUsageLedger.created_at, since),
  ));
  const buckets = await db.select({
    bucket: sql<string>`to_char(date_trunc('day', ${BillingUsageLedger.created_at}), 'YYYY-MM-DD')`,
    requests: sql<number>`count(*)::int`,
    credits: sql<string>`coalesce(sum(${BillingUsageLedger.charged_credits}), 0)`,
  }).from(BillingUsageLedger).where(and(
    eq(BillingUsageLedger.user_uuid, userUuid),
    eq(BillingUsageLedger.project_uuid, projectUuid),
    gte(BillingUsageLedger.created_at, since),
  )).groupBy(sql`date_trunc('day', ${BillingUsageLedger.created_at})`).orderBy(sql`date_trunc('day', ${BillingUsageLedger.created_at})`);
  const [keys, activity] = await Promise.all([
    db.select({ key_uuid: ApiKeys.key_uuid, name: ApiKeys.name, prefix: ApiKeys.key_prefix, scopes: ApiKeys.scopes, last_used_at: ApiKeys.last_used_at, expires_at: ApiKeys.expires_at, revoked_at: ApiKeys.revoked_at, created_at: ApiKeys.created_at })
      .from(ApiKeys).where(and(eq(ApiKeys.user_uuid, userUuid), eq(ApiKeys.project_uuid, projectUuid))).orderBy(desc(ApiKeys.created_at)),
    db.select({ usage_uuid: BillingUsageLedger.usage_uuid, usage_type: BillingUsageLedger.usage_type, quantity: BillingUsageLedger.quantity, charged_credits: BillingUsageLedger.charged_credits, created_at: BillingUsageLedger.created_at, api_key_uuid: BillingUsageLedger.api_key_uuid })
      .from(BillingUsageLedger).where(and(eq(BillingUsageLedger.user_uuid, userUuid), eq(BillingUsageLedger.project_uuid, projectUuid))).orderBy(desc(BillingUsageLedger.created_at)).limit(10),
  ]);
  return GenResObj(Code.OK, true, "Project fetched successfully", {
    ...project,
    usage: {
      ...totals,
      credits_used: Number(totals?.credits_used ?? 0),
      stt_seconds: Number(totals?.stt_seconds ?? 0),
      tts_characters: Number(totals?.tts_characters ?? 0),
      assistant_tokens: Number(totals?.assistant_tokens ?? 0),
      buckets: buckets.map((bucket) => ({ ...bucket, credits: Number(bucket.credits) })),
    },
    keys,
    recent_activity: activity,
  });
};

export const updateProject = async (userUuid: string, projectUuid: string, input: { name?: unknown; description?: unknown; status?: unknown }) => {
  const [existing] = await db.select().from(Projects)
    .where(and(eq(Projects.project_uuid, projectUuid), eq(Projects.user_uuid, userUuid))).limit(1);
  if (!existing) return GenResObj(Code.NOT_FOUND, false, "Project not found");

  const patch: Partial<typeof Projects.$inferInsert> = { updated_at: new Date() };
  if (input.name !== undefined) {
    const name = projectName(input.name);
    if (!name || name.toLowerCase() === "default project") return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "Enter a valid project name");
    if (existing.name === "Default project") return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "The default project cannot be renamed");
    patch.name = name;
  }
  if (input.description !== undefined) patch.description = projectDescription(input.description) || null;
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "archived") return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "Status must be active or archived");
    if (existing.name === "Default project" && input.status !== "active") return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "The default project cannot be archived");
    patch.status = input.status;
  }
  try {
    const [project] = await db.update(Projects).set(patch)
      .where(and(eq(Projects.project_uuid, projectUuid), eq(Projects.user_uuid, userUuid))).returning();
    if (!project) return GenResObj(Code.NOT_FOUND, false, "Project not found");
    return GenResObj(Code.OK, true, "Project updated successfully", project);
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") return GenResObj(Code.CONFLICT, false, "A project with this name already exists");
    throw error;
  }
};

export const archiveProject = async (userUuid: string, projectUuid: string) => {
  const [project] = await db.update(Projects).set({ status: "archived", updated_at: new Date() })
    .where(and(eq(Projects.project_uuid, projectUuid), eq(Projects.user_uuid, userUuid), eq(Projects.status, "active"), sql`${Projects.name} <> 'Default project'`)).returning();
  if (!project) return GenResObj(Code.NOT_FOUND, false, "Project not found or cannot be archived");
  return GenResObj(Code.OK, true, "Project archived successfully", project);
};

export const permanentlyDeleteProject = async (userUuid: string, projectUuid: string) => {
  return db.transaction(async (tx) => {
    const [project] = await tx.select().from(Projects).where(and(
      eq(Projects.project_uuid, projectUuid),
      eq(Projects.user_uuid, userUuid),
    )).limit(1).for("update");
    if (!project) return GenResObj(Code.NOT_FOUND, false, "Project not found");
    if (project.name === "Default project") return GenResObj(Code.UNPROCESSABLE_ENTITY, false, "The default project cannot be deleted");
    if (project.status !== "archived") return GenResObj(Code.CONFLICT, false, "Archive the project before permanently deleting it");

    // Keys are unusable after archive; remove their records so the project can
    // be deleted. Usage rows are retained, with their project reference nulled.
    await tx.delete(ApiKeys).where(and(
      eq(ApiKeys.project_uuid, projectUuid),
      eq(ApiKeys.user_uuid, userUuid),
    ));
    const [deleted] = await tx.delete(Projects).where(and(
      eq(Projects.project_uuid, projectUuid),
      eq(Projects.user_uuid, userUuid),
      eq(Projects.status, "archived"),
    )).returning({ project_uuid: Projects.project_uuid, name: Projects.name });
    if (!deleted) return GenResObj(Code.CONFLICT, false, "Project status changed; refresh and try again");
    return GenResObj(Code.OK, true, "Project permanently deleted", deleted);
  });
};
