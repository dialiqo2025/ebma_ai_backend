import "dotenv/config";
import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import { db, pool } from "../config/database/connection.database";
import {
  BillingPlans,
  BillingSubscriptions,
  BillingUsageLedger,
  BillingWallets,
  DailyUserReports,
  Users,
} from "../schema";
import {
  customPricingRecipient,
  renderDailyNewUsersReportEmail,
  sendEmail,
} from "../utils/email.util";

const DEFAULT_TIMEZONE = "Asia/Kolkata";

type CalendarParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const partsInTimezone = (date: Date, timezone: string): CalendarParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
};

const calendarDate = (date: Date, timezone: string) => {
  const parts = partsInTimezone(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
};

const addCalendarDays = (date: string, days: number) => {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + days));
  return shifted.toISOString().slice(0, 10);
};

/** Convert a local midnight in an IANA timezone into its UTC instant. */
const zonedMidnight = (date: string, timezone: string) => {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year!, month! - 1, day!);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = partsInTimezone(new Date(guess), timezone);
    const renderedAsUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second,
    );
    guess += target - renderedAsUtc;
  }
  return new Date(guess);
};

export const reportWindowForDate = (reportDate: string, timezone = DEFAULT_TIMEZONE) => ({
  reportDate,
  windowStart: zonedMidnight(reportDate, timezone),
  windowEnd: zonedMidnight(addCalendarDays(reportDate, 1), timezone),
  timezone,
});

const requestedReportDate = (timezone: string) => {
  const argument = process.argv.find((value) => value.startsWith("--date="))?.slice(7);
  const configured = argument || process.env.DAILY_USER_REPORT_DATE?.trim();
  if (configured) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(configured)) {
      throw new Error("Report date must use YYYY-MM-DD format");
    }
    const normalized = addCalendarDays(configured, 0);
    if (normalized !== configured) throw new Error(`Invalid report date: ${configured}`);
    return configured;
  }
  return addCalendarDays(calendarDate(new Date(), timezone), -1);
};

const envBoolean = (name: string, fallback = false) => {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["true", "1", "yes"].includes(value)) return true;
  if (["false", "0", "no"].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
};

const formatInTimezone = (date: Date | null, timezone: string) => {
  if (!date) return "";
  const parts = partsInTimezone(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;
};

const csvCell = (input: unknown) => {
  let value = input === null || input === undefined ? "" : String(input);
  // Prevent spreadsheet applications from evaluating user-controlled cells.
  if (/^[=+\-@\t\r]/.test(value)) value = `'${value}`;
  return `"${value.replaceAll('"', '""')}"`;
};

const buildCsv = (rows: Awaited<ReturnType<typeof loadRows>>, timezone: string) => {
  const headers = [
    "user_uuid",
    "full_name",
    "email",
    "company",
    "auth_provider",
    "role",
    "email_verified",
    "user_enabled",
    "registered_at",
    "last_login_at",
    "plan_name",
    "wallet_balance_credits",
    "usage_events",
    "tts_characters",
    "stt_seconds",
    "llm_tokens",
    "credits_used",
  ];
  const lines = rows.map((row) => [
    row.userUuid,
    row.fullName,
    row.email,
    row.companyName,
    row.authProvider,
    row.role,
    row.emailVerified,
    row.userEnabled,
    formatInTimezone(row.registeredAt, timezone),
    formatInTimezone(row.lastLoginAt, timezone),
    row.planName,
    Number(row.walletBalance ?? 0),
    Number(row.usageEvents ?? 0),
    Number(row.ttsCharacters ?? 0),
    Number(row.sttSeconds ?? 0),
    Number(row.llmTokens ?? 0),
    Number(row.creditsUsed ?? 0),
  ].map(csvCell).join(","));
  return Buffer.from(`\uFEFF${headers.map(csvCell).join(",")}\r\n${lines.join("\r\n")}\r\n`, "utf8");
};

export const loadRows = async (windowStart: Date, windowEnd: Date) => {
  const usage = db
    .select({
      userUuid: BillingUsageLedger.user_uuid,
      usageEvents: sql<number>`count(${BillingUsageLedger.usage_uuid})::int`.as("usage_events"),
      ttsCharacters: sql<string>`coalesce(sum(case when ${BillingUsageLedger.usage_type} = 'tts_characters' then ${BillingUsageLedger.quantity} else 0 end), 0)`.as("tts_characters"),
      sttSeconds: sql<string>`coalesce(sum(case when ${BillingUsageLedger.usage_type} = 'stt_seconds' then ${BillingUsageLedger.quantity} else 0 end), 0)`.as("stt_seconds"),
      llmTokens: sql<string>`coalesce(sum(case when ${BillingUsageLedger.usage_type} = 'llm_tokens' then ${BillingUsageLedger.quantity} else 0 end), 0)`.as("llm_tokens"),
      creditsUsed: sql<string>`coalesce(sum(${BillingUsageLedger.charged_credits}), 0)`.as("credits_used"),
    })
    .from(BillingUsageLedger)
    .where(and(
      gte(BillingUsageLedger.created_at, windowStart),
      lt(BillingUsageLedger.created_at, windowEnd),
    ))
    .groupBy(BillingUsageLedger.user_uuid)
    .as("daily_report_usage");

  return db
    .select({
      userUuid: Users.user_uuid,
      fullName: Users.fullName,
      email: Users.email,
      companyName: Users.company_name,
      authProvider: Users.auth_provider,
      role: Users.role,
      emailVerified: Users.email_verified,
      userEnabled: Users.user_enabled,
      registeredAt: Users.created_at,
      lastLoginAt: Users.last_login,
      planName: sql<string | null>`(
        select ${BillingPlans.name}
        from ${BillingSubscriptions}
        left join ${BillingPlans} on ${BillingPlans.plan_uuid} = ${BillingSubscriptions.plan_uuid}
        where ${BillingSubscriptions.user_uuid} = ${Users.user_uuid}
        order by case when ${BillingSubscriptions.status} = 'active' then 0 else 1 end,
                 ${BillingSubscriptions.created_at} desc
        limit 1
      )`.as("plan_name"),
      walletBalance: BillingWallets.balance_credits,
      usageEvents: usage.usageEvents,
      ttsCharacters: usage.ttsCharacters,
      sttSeconds: usage.sttSeconds,
      llmTokens: usage.llmTokens,
      creditsUsed: usage.creditsUsed,
    })
    .from(Users)
    .leftJoin(BillingWallets, eq(BillingWallets.user_uuid, Users.user_uuid))
    .leftJoin(usage, eq(usage.userUuid, Users.user_uuid))
    .where(and(gte(Users.created_at, windowStart), lt(Users.created_at, windowEnd)))
    .orderBy(Users.created_at);
};

const claimReport = async (params: {
  reportDate: string;
  windowStart: Date;
  windowEnd: Date;
  timezone: string;
  recipient: string;
}) => {
  const staleBefore = new Date(Date.now() - 60 * 60 * 1000);
  const [inserted] = await db
    .insert(DailyUserReports)
    .values({
      report_date: params.reportDate,
      window_start: params.windowStart,
      window_end: params.windowEnd,
      timezone: params.timezone,
      recipient: params.recipient,
      status: "processing",
    })
    .onConflictDoNothing()
    .returning({ reportDate: DailyUserReports.report_date });
  if (inserted) return true;

  const [retried] = await db
    .update(DailyUserReports)
    .set({
      status: "processing",
      recipient: params.recipient,
      error_message: null,
      started_at: new Date(),
      updated_at: new Date(),
    })
    .where(and(
      eq(DailyUserReports.report_date, params.reportDate),
      or(
        eq(DailyUserReports.status, "failed"),
        and(
          eq(DailyUserReports.status, "processing"),
          lt(DailyUserReports.started_at, staleBefore),
        ),
      ),
    ))
    .returning({ reportDate: DailyUserReports.report_date });
  return Boolean(retried);
};

export const sendDailyNewUsersReport = async () => {
  const timezone = process.env.DAILY_USER_REPORT_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
  // Validate the configured IANA timezone before claiming a report run.
  partsInTimezone(new Date(), timezone);
  const reportDate = requestedReportDate(timezone);
  const { windowStart, windowEnd } = reportWindowForDate(reportDate, timezone);
  const recipient = process.env.DAILY_USER_REPORT_TO_EMAIL?.trim() || customPricingRecipient();
  const sendEmpty = envBoolean("DAILY_USER_REPORT_SEND_EMPTY");

  const claimed = await claimReport({ reportDate, windowStart, windowEnd, timezone, recipient });
  if (!claimed) {
    console.log(`Daily new-user report ${reportDate} was already claimed or completed; skipping.`);
    return { reportDate, status: "already-claimed" as const, rowCount: 0 };
  }

  try {
    const rows = await loadRows(windowStart, windowEnd);
    if (!rows.length && !sendEmpty) {
      await db
        .update(DailyUserReports)
        .set({ status: "skipped", row_count: 0, updated_at: new Date() })
        .where(eq(DailyUserReports.report_date, reportDate));
      console.log(`Daily new-user report ${reportDate}: no registrations; email skipped.`);
      return { reportDate, status: "skipped" as const, rowCount: 0 };
    }

    const csv = buildCsv(rows, timezone);
    const delivery = await sendEmail({
      to: recipient,
      subject: `[Daily New Users] ${reportDate} — ${rows.length} ${rows.length === 1 ? "registration" : "registrations"}`,
      text: `Attached is the new-user report for ${reportDate} (${timezone}). Registrations: ${rows.length}.`,
      html: renderDailyNewUsersReportEmail({ reportDate, timezone, userCount: rows.length }),
      attachments: [{
        filename: `ebma-new-users-${reportDate}.csv`,
        content: csv,
        contentType: "text/csv; charset=utf-8",
      }],
      idempotencyKey: `daily-new-users/${reportDate}`,
    });

    await db
      .update(DailyUserReports)
      .set({
        status: "sent",
        row_count: rows.length,
        provider_message_id: delivery.messageId,
        sent_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(DailyUserReports.report_date, reportDate));
    console.log(`Daily new-user report ${reportDate}: sent ${rows.length} rows to ${recipient}.`);
    return { reportDate, status: "sent" as const, rowCount: rows.length };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await db
      .update(DailyUserReports)
      .set({ status: "failed", error_message: errorMessage, updated_at: new Date() })
      .where(eq(DailyUserReports.report_date, reportDate));
    throw error;
  }
};

const main = async () => {
  try {
    await sendDailyNewUsersReport();
  } catch (error) {
    console.error("Daily new-user report failed", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

if (require.main === module) void main();
