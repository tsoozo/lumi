/**
 * Cron jobs (every 15 min). Each job processes a small batch (CPU limit: 10 ms on the free plan) and is
 * idempotent: every state change is a guarded UPDATE, so running twice never changes amounts twice.
 */
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { contests, entries, handovers, payments, payouts, type Contest } from "../db/schema";
import { formatMNT, splitEvenly } from "../lib/money";
import { DAY, HOUR, ubDateTime, ubHourMinute } from "../lib/time";
import { audit } from "./audit";
import { SYSTEM, type Ctx } from "./context";
import { transition } from "./contestState";
import { countActiveEntries } from "./contests";
import { startFullRefund } from "./entries";
import { completeHandover } from "./handovers";
import { notifyUser } from "./notify";
import { createPayouts, dispatchReadyPayouts } from "./payouts";
import { getSettings } from "./settings";
import { todayReport } from "./admin";

const BATCH = 20;

/** active/extended past submission deadline -> selecting (+7 days to choose). */
export async function closeSubmissions(ctx: Ctx) {
  const s = await getSettings(ctx.db);
  const due = await ctx.db
    .select()
    .from(contests)
    .where(and(inArray(contests.status, ["active", "extended"]), lte(contests.submissionDeadline, ctx.now())))
    .orderBy(asc(contests.submissionDeadline))
    .limit(BATCH);
  for (const c of due) {
    const rows = await ctx.db
      .update(contests)
      .set({ status: "selecting", selectionDeadline: ctx.now() + s.selection_days * DAY, selectionReminders: 0, updatedAt: ctx.now() })
      .where(and(eq(contests.id, c.id), inArray(contests.status, ["active", "extended"])))
      .returning();
    if (!rows.length) continue;
    await audit(ctx.db, SYSTEM, "contest.submissions_closed", "contest", c.id, { status: c.status }, { status: "selecting" });
    const n = await countActiveEntries(ctx, c.id);
    if (n < s.min_entries) await notifyUser(ctx, c.clientId, "low_entries", { title: c.title, count: n, contestId: c.id });
    else await notifyUser(ctx, c.clientId, "submission_closed", { title: c.title, days: s.selection_days, contestId: c.id });
  }
  return due.length;
}

/**
 * selecting past selection deadline:
 *  - send up to N reminders (spread over the last days), then give one grace period of 7 days;
 *  - still no winner -> split the prize: finalists if any, else all valid entries. 0 entries -> refund.
 */
export async function enforceSelection(ctx: Ctx) {
  const s = await getSettings(ctx.db);
  // Reminders: in the last 2 days before the deadline, one per day.
  const remind = await ctx.db
    .select()
    .from(contests)
    .where(
      and(
        eq(contests.status, "selecting"),
        lte(contests.selectionDeadline, ctx.now() + 2 * DAY),
        sql`${contests.selectionDeadline} > ${ctx.now()}`,
        sql`${contests.selectionReminders} < ${s.selection_reminders}`,
      ),
    )
    .limit(BATCH);
  for (const c of remind) {
    const sent = c.selectionReminders;
    const due = c.selectionDeadline! - (s.selection_reminders - sent) * DAY;
    if (ctx.now() < due) continue;
    const rows = await ctx.db
      .update(contests)
      .set({ selectionReminders: sent + 1 })
      .where(and(eq(contests.id, c.id), eq(contests.selectionReminders, sent)))
      .returning({ id: contests.id });
    if (rows.length) await notifyUser(ctx, c.clientId, "selection_reminder", { title: c.title, contestId: c.id });
  }

  const expired = await ctx.db
    .select()
    .from(contests)
    .where(and(eq(contests.status, "selecting"), lte(contests.selectionDeadline, ctx.now())))
    .limit(BATCH);
  for (const c of expired) {
    const n = await countActiveEntries(ctx, c.id);
    if (n === 0) {
      await startFullRefund(ctx, SYSTEM, c, "no_entries").catch(ignoreConflict);
      continue;
    }
    if (!c.selectionGraceUsed) {
      const rows = await ctx.db
        .update(contests)
        .set({ selectionGraceUsed: true, selectionDeadline: ctx.now() + s.selection_grace_days * DAY, selectionReminders: 0 })
        .where(and(eq(contests.id, c.id), eq(contests.selectionGraceUsed, false), eq(contests.status, "selecting")))
        .returning({ id: contests.id });
      if (rows.length) {
        await audit(ctx.db, SYSTEM, "contest.selection_grace", "contest", c.id);
        await notifyUser(ctx, c.clientId, "selection_reminder", { title: c.title, contestId: c.id, grace: true });
      }
      continue;
    }
    await splitPrize(ctx, c);
  }
  return expired.length;
}

/** Guaranteed contest: the client didn't choose, so the prize is split evenly. Client gets no usage rights. */
export async function splitPrize(ctx: Ctx, c: Contest) {
  const active = await ctx.db
    .select()
    .from(entries)
    .where(and(eq(entries.contestId, c.id), eq(entries.status, "active")))
    .orderBy(asc(entries.id));
  const finalists = active.filter((e) => e.isFinalist);
  const pool = finalists.length ? finalists : active;
  // One share per creator (a creator with 3 entries shouldn't get 3 shares).
  const creators = [...new Set(pool.map((e) => e.creatorId))];
  if (!creators.length) return null;
  const amounts = splitEvenly(c.prizeAmount, creators.length);
  try {
    await transition(ctx.db, c.id, ["selecting"], "payout_pending");
  } catch (e) {
    return ignoreConflict(e);
  }
  await audit(ctx.db, SYSTEM, "contest.split_prize", "contest", c.id, { status: "selecting" }, { status: "payout_pending", creators, amounts, basis: finalists.length ? "finalists" : "all" });
  await createPayouts(ctx, c.id, "split_prize", creators.map((id, i) => ({ recipientId: id, amount: amounts[i]! })));
  for (let i = 0; i < creators.length; i++) {
    await notifyUser(ctx, creators[i]!, "split_prize", { title: c.title, amount: amounts[i], contestId: c.id });
  }
  await notifyUser(ctx, c.clientId, "split_prize_client", { title: c.title, contestId: c.id });
  return amounts;
}

/** Client didn't respond within 3 days after files were sent -> auto accepted. */
export async function autoAcceptHandovers(ctx: Ctx) {
  const due = await ctx.db
    .select()
    .from(handovers)
    .where(and(eq(handovers.status, "files_sent"), lte(handovers.acceptDeadline, ctx.now())))
    .limit(BATCH);
  for (const h of due) await completeHandover(ctx, SYSTEM, h, "auto_accepted");
  // Winner hasn't sent files in time: flag to admins (no automatic money move here).
  const late = await ctx.db
    .select()
    .from(handovers)
    .where(and(eq(handovers.status, "waiting_files"), lte(handovers.filesDeadline, ctx.now())))
    .limit(BATCH);
  for (const h of late) {
    const rows = await ctx.db
      .update(handovers)
      .set({ status: "disputed" })
      .where(and(eq(handovers.id, h.id), eq(handovers.status, "waiting_files")))
      .returning({ id: handovers.id });
    if (!rows.length) continue;
    await ctx.db.update(contests).set({ status: "disputed", updatedAt: ctx.now() }).where(and(eq(contests.id, h.contestId), eq(contests.status, "handover")));
    await audit(ctx.db, SYSTEM, "handover.files_late", "handover", h.id);
    await ctx.admin.broadcast(`⚠️ Ялагч эх файлаа хугацаандаа илгээгээгүй (уралдаан #${h.contestId}). Шийдвэрлэнэ үү.`).catch(() => {});
  }
  return due.length + late.length;
}

/** Bot reminders: payment unreviewed > 2h, payout due in < 1 day. */
export async function adminReminders(ctx: Ctx) {
  const s = await getSettings(ctx.db);
  const stale = await ctx.db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.status, "reported"),
        lte(payments.createdAt, ctx.now() - s.payment_reminder_hours * HOUR),
        or(isNull(payments.lastReminderAt), lte(payments.lastReminderAt, ctx.now() - s.payment_reminder_hours * HOUR)),
      ),
    )
    .limit(BATCH);
  if (stale.length) {
    await ctx.db.update(payments).set({ lastReminderAt: ctx.now() }).where(inArray(payments.id, stale.map((p) => p.id)));
    await ctx.admin.broadcast(`⏰ ${stale.length} төлбөр ${s.payment_reminder_hours}+ цаг шалгагдаагүй байна. /pending`, ["reviewer", "finance"]);
  }
  const duePayouts = await ctx.db
    .select()
    .from(payouts)
    .where(and(eq(payouts.status, "pending"), isNull(payouts.reminderSentAt), lte(payouts.dueAt, ctx.now() + DAY)))
    .limit(BATCH);
  if (duePayouts.length) {
    await ctx.db.update(payouts).set({ reminderSentAt: ctx.now() }).where(inArray(payouts.id, duePayouts.map((p) => p.id)));
    const lines = duePayouts.map((p) => `• #${p.id} ${formatMNT(p.amount)} — эцсийн хугацаа ${ubDateTime(p.dueAt)}`);
    await ctx.admin.broadcast(`⏰ Шилжүүлэх хугацаа ойртсон:\n${lines.join("\n")}\n/payouts`, ["finance"]);
  }
}

/** 09:00 Ulaanbaatar daily summary. Cron runs every 15 min, so fire in the 09:00–09:14 window. */
export async function dailyReport(ctx: Ctx) {
  const { hour, minute } = ubHourMinute(ctx.now());
  if (hour !== 9 || minute >= 15) return false;
  const r = await todayReport(ctx);
  await ctx.admin.broadcast(
    `☀️ Өглөөний тайлан\nШалгах төлбөр: ${r.pendingPayments}\nШилжүүлэх: ${r.pendingPayouts}\nНээлттэй мэдээлэл: ${r.openReports}`,
  );
  return true;
}

function ignoreConflict(e: unknown) {
  if (e && typeof e === "object" && "status" in e && (e as { status: number }).status === 409) return null;
  throw e;
}

export async function runCron(ctx: Ctx) {
  const jobs: [string, (c: Ctx) => Promise<unknown>][] = [
    ["closeSubmissions", closeSubmissions],
    ["enforceSelection", enforceSelection],
    ["autoAcceptHandovers", autoAcceptHandovers],
    ["dispatchReadyPayouts", (c) => dispatchReadyPayouts(c)],
    ["adminReminders", adminReminders],
    ["dailyReport", dailyReport],
  ];
  for (const [name, job] of jobs) {
    try {
      await job(ctx);
    } catch (e) {
      console.error(`cron ${name} failed`, e); // keep going; next run retries
    }
  }
}
