import "dotenv/config";
import { and, eq, lt, or } from "drizzle-orm";
import { db, pool } from "../config/database/connection.database";
import { DailyUsageReports } from "../schema";
import {
  buildUsageDetailsCsv,
  buildUsageSummaryCsv,
  loadUsageReport,
} from "../services/billing/billing.usage-report";
import {
  customPricingRecipient,
  renderDailyUsageReportEmail,
  sendEmail,
} from "../utils/email.util";

const DEFAULT_TIMEZONE = "Asia/Kolkata";

const partsInTimezone = (date: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
};

const calendarDate = (date: Date, timezone: string) => {
  const parts = partsInTimezone(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
};

const addDays = (date: string, days: number) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
};

const zonedMidnight = (date: string, timezone: string) => {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year!, month! - 1, day!);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = partsInTimezone(new Date(guess), timezone);
    const renderedAsUtc = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute, rendered.second);
    guess += target - renderedAsUtc;
  }
  return new Date(guess);
};

const envBoolean = (name: string, fallback = false) => {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["true", "1", "yes"].includes(value)) return true;
  if (["false", "0", "no"].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
};

const reportDateInput = (timezone: string) => {
  const argument = process.argv.find((value) => value.startsWith("--date="))?.slice(7);
  const configured = argument || process.env.DAILY_USAGE_REPORT_DATE?.trim();
  const result = configured || addDays(calendarDate(new Date(), timezone), -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || addDays(result, 0) !== result) throw new Error("Report date must be a valid YYYY-MM-DD date");
  return result;
};

const claim = async (input: { reportDate: string; from: Date; to: Date; timezone: string; recipient: string }) => {
  const [inserted] = await db.insert(DailyUsageReports).values({
    report_date: input.reportDate, window_start: input.from, window_end: input.to,
    timezone: input.timezone, recipient: input.recipient, status: "processing",
  }).onConflictDoNothing().returning({ reportDate: DailyUsageReports.report_date });
  if (inserted) return true;
  const [retried] = await db.update(DailyUsageReports).set({
    status: "processing", recipient: input.recipient, error_message: null,
    started_at: new Date(), updated_at: new Date(),
  }).where(and(
    eq(DailyUsageReports.report_date, input.reportDate),
    or(
      eq(DailyUsageReports.status, "failed"),
      and(eq(DailyUsageReports.status, "processing"), lt(DailyUsageReports.started_at, new Date(Date.now() - 3_600_000))),
    ),
  )).returning({ reportDate: DailyUsageReports.report_date });
  return Boolean(retried);
};

export const sendDailyUsageReport = async () => {
  if (!envBoolean("DAILY_USAGE_REPORT_ENABLED", true)) return { status: "disabled" as const, rowCount: 0 };
  const timezone = process.env.DAILY_USAGE_REPORT_TIMEZONE?.trim()
    || process.env.DAILY_USER_REPORT_TIMEZONE?.trim()
    || DEFAULT_TIMEZONE;
  partsInTimezone(new Date(), timezone);
  const reportDate = reportDateInput(timezone);
  const from = zonedMidnight(reportDate, timezone);
  const to = zonedMidnight(addDays(reportDate, 1), timezone);
  const recipient = process.env.DAILY_USAGE_REPORT_TO_EMAIL?.trim()
    || process.env.DAILY_USER_REPORT_TO_EMAIL?.trim()
    || customPricingRecipient();
  const includeDetails = envBoolean("DAILY_USAGE_REPORT_INCLUDE_DETAILS", true);
  const sendEmpty = envBoolean("DAILY_USAGE_REPORT_SEND_EMPTY");
  if (!await claim({ reportDate, from, to, timezone, recipient })) {
    console.log(`Daily usage report ${reportDate} was already claimed or completed; skipping.`);
    return { reportDate, status: "already-claimed" as const, rowCount: 0 };
  }
  try {
    const report = await loadUsageReport({ from, to, timezone });
    const summaries = report.summaries.filter((row) => row.totalRequests > 0 || row.totalCreditsUsed > 0);
    if (!report.details.length && !sendEmpty) {
      await db.update(DailyUsageReports).set({ status: "skipped", updated_at: new Date() })
        .where(eq(DailyUsageReports.report_date, reportDate));
      console.log(`Daily usage report ${reportDate}: no usage; email skipped.`);
      return { reportDate, status: "skipped" as const, rowCount: 0 };
    }
    const creditsUsed = summaries.reduce((sum, row) => sum + row.totalCreditsUsed, 0);
    const attachments = [{
      filename: `ebma-user-usage-summary-${reportDate}.csv`,
      content: buildUsageSummaryCsv(summaries),
      contentType: "text/csv; charset=utf-8",
    }];
    if (includeDetails) attachments.push({
      filename: `ebma-user-usage-details-${reportDate}.csv`,
      content: buildUsageDetailsCsv(report.details, timezone),
      contentType: "text/csv; charset=utf-8",
    });
    const delivery = await sendEmail({
      to: recipient,
      subject: `[Daily User Usage] ${reportDate} — ${report.details.length} requests`,
      text: `Attached is the user usage report for ${reportDate} (${timezone}). Requests: ${report.details.length}. Credits: ${creditsUsed.toFixed(6)}.`,
      html: renderDailyUsageReportEmail({ reportDate, timezone, userCount: summaries.length, requestCount: report.details.length, creditsUsed }),
      attachments,
      idempotencyKey: `daily-user-usage/${reportDate}`,
    });
    await db.update(DailyUsageReports).set({
      status: "sent", summary_row_count: summaries.length, detail_row_count: report.details.length,
      provider_message_id: delivery.messageId, sent_at: new Date(), updated_at: new Date(),
    }).where(eq(DailyUsageReports.report_date, reportDate));
    console.log(`Daily usage report ${reportDate}: sent ${report.details.length} request rows to ${recipient}.`);
    return { reportDate, status: "sent" as const, rowCount: report.details.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(DailyUsageReports).set({ status: "failed", error_message: message.slice(0, 10_000), updated_at: new Date() })
      .where(eq(DailyUsageReports.report_date, reportDate));
    throw error;
  }
};

const main = async () => {
  try {
    await sendDailyUsageReport();
  } catch (error) {
    console.error("Daily usage report failed", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

if (require.main === module) void main();

