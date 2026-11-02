import { and, desc, eq, gte, inArray, sql, sum, count } from "drizzle-orm";
import { adminInvites, auditLogs, contests, payments, payouts, reports, users } from "../db/schema";
import { randomToken, sha256Hex } from "../lib/crypto";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { ubStartOfDay } from "../lib/time";
import { audit } from "./audit";
import { requireAdminLevel, type Actor, type Ctx } from "./context";
import { transition } from "./contestState";
import { countActiveEntries, getContest, publishFields } from "./contests";
import { startFullRefund } from "./entries";
import { notifyUser } from "./notify";

/** pending_approval -> active (only used when auto_approve_contests = false). */
export async function approveContest(ctx: Ctx, actor: Actor, contestId: number) {
  requireAdminLevel(actor, ["reviewer"]);
  const c = await getContest(ctx, contestId);
  const next = await transition(ctx.db, contestId, ["pending_approval"], "active", publishFields(c, ctx.now()));
  await audit(ctx.db, actor, "contest.approve", "contest", contestId, { status: c.status }, { status: next.status });
  await notifyUser(ctx, c.clientId, "contest_published", { title: c.title, contestId });
  return next;
}

/** Brief violates the rules: refund case #1 (100%). */
export async function rejectContest(ctx: Ctx, actor: Actor, contestId: number, reason: string) {
  requireAdminLevel(actor, ["reviewer"]);
  const c = await getContest(ctx, contestId);
  if (c.status !== "pending_approval") throw badRequest("invalid_state", "Зөвшөөрөл хүлээж буй уралдаан биш");
  await notifyUser(ctx, c.clientId, "contest_rejected", { title: c.title, reason, contestId });
  return startFullRefund(ctx, actor, c, `rejected: ${reason}`);
}

/** All entries were removed as plagiarised / rule-breaking: refund case #3 (100%). */
export async function refundAfterRemovals(ctx: Ctx, actor: Actor, contestId: number) {
  requireAdminLevel(actor, ["finance"]);
  const c = await getContest(ctx, contestId);
  if (!["selecting", "disputed"].includes(c.status)) throw badRequest("invalid_state", "Энэ үед буцаалт хийх боломжгүй");
  if ((await countActiveEntries(ctx, contestId)) > 0) throw badRequest("has_entries", "Хүчинтэй бүтээл үлдсэн байна");
  return startFullRefund(ctx, actor, c, "all_entries_removed");
}

export async function cancelContest(ctx: Ctx, actor: Actor, contestId: number) {
  requireAdminLevel(actor, ["reviewer"]);
  const c = await getContest(ctx, contestId);
  const next = await transition(ctx.db, contestId, ["draft", "awaiting_payment"], "cancelled");
  await audit(ctx.db, actor, "contest.admin_cancel", "contest", contestId, { status: c.status }, { status: next.status });
  return next;
}

// ------------------------------------------------------------------ admin onboarding (Telegram)

/** Super admin creates a one-time code (15 min). The new admin sends `/start <code>` to the bot. */
export async function createAdminInvite(ctx: Ctx, actor: Actor, email: string, level: "reviewer" | "finance" | "super") {
  requireAdminLevel(actor, ["super"]);
  if (actor.adminLevel !== "super") throw forbidden();
  let u = await ctx.db.select().from(users).where(eq(users.email, email.toLowerCase().trim())).get();
  if (!u) [u] = await ctx.db.insert(users).values({ email: email.toLowerCase().trim() }).returning();
  await ctx.db.update(users).set({ role: "admin", adminLevel: level }).where(eq(users.id, u!.id));
  const code = randomToken(9);
  await ctx.db.insert(adminInvites).values({ codeHash: await sha256Hex(code), userId: u!.id, expiresAt: ctx.now() + 15 * 60, createdBy: actor.id! });
  await audit(ctx.db, actor, "admin.invite", "user", u!.id, undefined, { level });
  return { code, expiresInMinutes: 15 };
}

export async function redeemAdminInvite(ctx: Ctx, code: string, chatId: string) {
  const hash = await sha256Hex(code.trim());
  const rows = await ctx.db
    .update(adminInvites)
    .set({ usedAt: ctx.now() })
    .where(and(eq(adminInvites.codeHash, hash), sql`${adminInvites.usedAt} IS NULL`, gte(adminInvites.expiresAt, ctx.now())))
    .returning();
  if (!rows.length) throw badRequest("bad_code", "Код буруу эсвэл хугацаа дууссан");
  try {
    await ctx.db.update(users).set({ telegramChatId: chatId }).where(eq(users.id, rows[0]!.userId));
  } catch {
    throw conflict("chat_taken", "Энэ Telegram аль хэдийн өөр админтай холбогдсон байна");
  }
  const u = await ctx.db.select().from(users).where(eq(users.id, rows[0]!.userId)).get();
  await audit(ctx.db, { type: "telegram", id: u!.id }, "admin.telegram_linked", "user", u!.id);
  return u!;
}

export async function adminByChatId(ctx: Ctx, chatId: string) {
  const u = await ctx.db.select().from(users).where(and(eq(users.telegramChatId, chatId), eq(users.role, "admin"))).get();
  if (!u || u.isBanned || !u.adminLevel) return null;
  return u;
}

export async function listAdminChats(ctx: Ctx, levels?: string[]) {
  const rows = await ctx.db
    .select({ chatId: users.telegramChatId, level: users.adminLevel })
    .from(users)
    .where(and(eq(users.role, "admin"), sql`${users.telegramChatId} IS NOT NULL`, eq(users.isBanned, false)));
  return rows.filter((r) => !levels || r.level === "super" || levels.includes(r.level!)).map((r) => r.chatId!);
}

// ------------------------------------------------------------------ reports / logs

export async function createReport(ctx: Ctx, actor: Actor, input: { contestId: number; entryId?: number; reason: string; details?: string }) {
  await getContest(ctx, input.contestId);
  if (!input.reason?.trim()) throw badRequest("reason", "Шалтгаан оруулна уу");
  const [r] = await ctx.db
    .insert(reports)
    .values({ contestId: input.contestId, entryId: input.entryId ?? null, reporterId: actor.id!, reason: input.reason.slice(0, 100), details: (input.details ?? "").slice(0, 2000) })
    .returning();
  await ctx.admin.broadcast(`🚩 Шинэ мэдээлэл #${r!.id}: ${r!.reason} (уралдаан #${input.contestId})`).catch(() => {});
  return r!;
}

export async function resolveReport(ctx: Ctx, actor: Actor, id: number, status: "resolved" | "rejected", resolution: string) {
  requireAdminLevel(actor, ["reviewer", "finance"]);
  const [r] = await ctx.db
    .update(reports)
    .set({ status, resolution, resolvedBy: actor.id })
    .where(and(eq(reports.id, id), eq(reports.status, "open")))
    .returning();
  if (!r) throw notFound();
  await audit(ctx.db, actor, "report.resolve", "report", id, undefined, { status, resolution });
  return r;
}

export async function listAuditLogs(ctx: Ctx, q: { entityType?: string; entityId?: number; page?: number }) {
  const where = [];
  if (q.entityType) where.push(eq(auditLogs.entityType, q.entityType));
  if (q.entityId) where.push(eq(auditLogs.entityId, q.entityId));
  return ctx.db
    .select()
    .from(auditLogs)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLogs.id))
    .limit(100)
    .offset(((q.page ?? 1) - 1) * 100);
}

/** /today: money in, money out, 5% revenue (fee of contests completed today). */
export async function todayReport(ctx: Ctx) {
  const start = ubStartOfDay(ctx.now());
  const inRow = await ctx.db.select({ s: sum(payments.receivedAmount), n: count() }).from(payments).where(and(eq(payments.status, "confirmed"), gte(payments.reviewedAt, start))).get();
  const outRow = await ctx.db.select({ s: sum(payouts.amount), n: count() }).from(payouts).where(and(eq(payouts.status, "sent"), gte(payouts.sentAt, start))).get();
  const feeRow = await ctx.db
    .select({ s: sum(contests.feeAmount) })
    .from(contests)
    .where(and(eq(contests.status, "completed"), gte(contests.updatedAt, start)))
    .get();
  const pendingPayments = await ctx.db.select({ n: count() }).from(payments).where(eq(payments.status, "reported")).get();
  const pendingPayouts = await ctx.db.select({ n: count() }).from(payouts).where(inArray(payouts.status, ["pending"])).get();
  const openReports = await ctx.db.select({ n: count() }).from(reports).where(eq(reports.status, "open")).get();
  return {
    inAmount: Number(inRow?.s ?? 0),
    inCount: inRow?.n ?? 0,
    outAmount: Number(outRow?.s ?? 0),
    outCount: outRow?.n ?? 0,
    feeRevenue: Number(feeRow?.s ?? 0),
    pendingPayments: pendingPayments?.n ?? 0,
    pendingPayouts: pendingPayouts?.n ?? 0,
    openReports: openReports?.n ?? 0,
  };
}
