import { and, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { bankAccounts, contests, payouts, users, type Payout } from "../db/schema";
import { decryptField } from "../lib/crypto";
import { badRequest, conflict, notFound } from "../lib/errors";
import { addBusinessDays, HOUR } from "../lib/time";
import { audit } from "./audit";
import { requireAdminLevel, SYSTEM, type Actor, type Ctx } from "./context";
import { transition } from "./contestState";
import { notifyUser } from "./notify";
import { getSettings } from "./settings";

export type PayoutType = "prize" | "split_prize" | "refund";

export async function activeBankAccount(ctx: Ctx, userId: number) {
  return ctx.db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.userId, userId), eq(bankAccounts.isActive, true)))
    .orderBy(desc(bankAccounts.id))
    .get();
}

/**
 * Creates payout rows (idempotent: unique contest+recipient+type). Amounts are always computed by the
 * system, never typed by an admin.
 */
export async function createPayouts(
  ctx: Ctx,
  contestId: number,
  type: PayoutType,
  items: { recipientId: number; amount: number }[],
): Promise<Payout[]> {
  const s = await getSettings(ctx.db);
  const dueAt = addBusinessDays(ctx.now(), s.payout_business_days);
  const created: Payout[] = [];
  for (const it of items) {
    if (it.amount <= 0) continue;
    const acct = await activeBankAccount(ctx, it.recipientId);
    const rows = await ctx.db
      .insert(payouts)
      .values({ contestId, recipientId: it.recipientId, bankAccountId: acct?.id ?? null, type, amount: it.amount, dueAt })
      .onConflictDoNothing()
      .returning();
    if (rows[0]) {
      created.push(rows[0]);
      await audit(ctx.db, SYSTEM, "payout.create", "payout", rows[0].id, undefined, { type, amount: it.amount, recipientId: it.recipientId });
      if (!acct) await notifyUser(ctx, it.recipientId, "bank_account_required", { amount: it.amount, contestId });
    }
  }
  for (const p of created) await dispatchPayout(ctx, p.id);
  return created;
}

/**
 * Sends the "transfer this" message to finance admins once the payout has a usable bank account.
 * Safe to call repeatedly (cron does): it only sends when no message was sent yet.
 */
export async function dispatchPayout(ctx: Ctx, payoutId: number): Promise<boolean> {
  const p = await ctx.db.select().from(payouts).where(eq(payouts.id, payoutId)).get();
  if (!p || p.status !== "pending" || p.telegramMessageId || !p.bankAccountId) return false;
  const acct = await ctx.db.select().from(bankAccounts).where(eq(bankAccounts.id, p.bankAccountId)).get();
  if (!acct || (acct.lockedUntil && acct.lockedUntil > ctx.now())) return false;
  const c = await ctx.db.select().from(contests).where(eq(contests.id, p.contestId)).get();
  if (!c) return false;
  // Claim the dispatch so two cron runs don't send two messages.
  const claimed = await ctx.db
    .update(payouts)
    .set({ telegramMessageId: "sending" })
    .where(and(eq(payouts.id, p.id), isNull(payouts.telegramMessageId)))
    .returning({ id: payouts.id });
  if (!claimed.length) return false;
  try {
    await ctx.admin.payoutReady({ ...p, telegramMessageId: "sending" }, c);
  } catch (e) {
    await ctx.db.update(payouts).set({ telegramMessageId: null }).where(eq(payouts.id, p.id));
    throw e;
  }
  return true;
}

/** Details for the admin message / panel. Decrypts the account number (finance only). */
export async function payoutDetails(ctx: Ctx, payoutId: number) {
  const p = await ctx.db.select().from(payouts).where(eq(payouts.id, payoutId)).get();
  if (!p) throw notFound();
  const c = await ctx.db.select().from(contests).where(eq(contests.id, p.contestId)).get();
  const u = await ctx.db.select().from(users).where(eq(users.id, p.recipientId)).get();
  const acct = p.bankAccountId ? await ctx.db.select().from(bankAccounts).where(eq(bankAccounts.id, p.bankAccountId)).get() : undefined;
  const accountNumber = acct ? await decryptField(acct.accountNumberEncrypted, ctx.env.BANK_ENCRYPTION_KEY) : null;
  return { payout: p, contest: c!, recipient: u!, account: acct ?? null, accountNumber };
}

/** Finance admin confirms they transferred the money from the bank app. */
export async function markPayoutSent(
  ctx: Ctx,
  actor: Actor,
  payoutId: number,
  opts: { bankTransactionRef?: string; proofImageUrl?: string },
): Promise<Payout> {
  requireAdminLevel(actor, ["finance"]);
  if (!opts.bankTransactionRef?.trim() && !opts.proofImageUrl) {
    throw badRequest("proof_required", "Гүйлгээний дугаар эсвэл баримтын зураг шаардлагатай");
  }
  const before = await ctx.db.select().from(payouts).where(eq(payouts.id, payoutId)).get();
  if (!before) throw notFound();
  if (before.bankAccountId) {
    const acct = await ctx.db.select().from(bankAccounts).where(eq(bankAccounts.id, before.bankAccountId)).get();
    if (acct?.lockedUntil && acct.lockedUntil > ctx.now()) throw conflict("account_locked", "Данс саяхан өөрчлөгдсөн тул түгжээтэй байна");
  } else {
    throw badRequest("no_account", "Хүлээн авагч данс бүртгүүлээгүй байна");
  }
  const rows = await ctx.db
    .update(payouts)
    .set({
      status: "sent",
      sentBy: actor.id,
      sentAt: ctx.now(),
      bankTransactionRef: opts.bankTransactionRef?.trim() || null,
      proofImageUrl: opts.proofImageUrl ?? null,
    })
    .where(and(eq(payouts.id, payoutId), eq(payouts.status, "pending")))
    .returning();
  if (!rows.length) throw conflict("already_resolved", "Энэ шилжүүлгийг өөр админ аль хэдийн шийдсэн байна");
  const p = rows[0]!;
  await audit(ctx.db, actor, "payout.mark_sent", "payout", p.id, { status: before.status }, { status: "sent", ref: p.bankTransactionRef });
  await notifyUser(ctx, p.recipientId, "payout_sent", { amount: p.amount, ref: p.bankTransactionRef, contestId: p.contestId });
  await finishContestIfAllSent(ctx, p.contestId);
  const c = await ctx.db.select().from(contests).where(eq(contests.id, p.contestId)).get();
  if (c) await ctx.admin.payoutResolved(p, c, `📤 Шилжүүлсэн`).catch((e) => console.error(e));
  return p;
}

export async function finishContestIfAllSent(ctx: Ctx, contestId: number) {
  const open = await ctx.db
    .select({ id: payouts.id })
    .from(payouts)
    .where(and(eq(payouts.contestId, contestId), ne(payouts.status, "sent")))
    .get();
  if (open) return;
  const c = await ctx.db.select().from(contests).where(eq(contests.id, contestId)).get();
  if (!c) return;
  try {
    if (c.status === "payout_pending") {
      await transition(ctx.db, contestId, ["payout_pending"], "completed", { updatedAt: ctx.now() });
      await audit(ctx.db, SYSTEM, "contest.completed", "contest", contestId, { status: c.status }, { status: "completed" });
    } else if (c.status === "refund_pending") {
      await transition(ctx.db, contestId, ["refund_pending"], "refunded", { updatedAt: ctx.now() });
      await audit(ctx.db, SYSTEM, "contest.refunded", "contest", contestId, { status: c.status }, { status: "refunded" });
    }
  } catch (e) {
    // Another request finished it concurrently; that's fine.
    if (!(e instanceof Error && "status" in e && (e as { status: number }).status === 409)) throw e;
  }
}

/** "⏸ Асуудалтай": wrong account etc. Recipient is asked to check their bank details. */
export async function markPayoutProblem(ctx: Ctx, actor: Actor, payoutId: number, reason: string) {
  requireAdminLevel(actor, ["finance"]);
  const rows = await ctx.db
    .update(payouts)
    .set({ status: "failed", failReason: reason.slice(0, 500) })
    .where(and(eq(payouts.id, payoutId), eq(payouts.status, "pending")))
    .returning();
  if (!rows.length) throw conflict("already_resolved", "Энэ шилжүүлгийг өөр админ аль хэдийн шийдсэн байна");
  const p = rows[0]!;
  await audit(ctx.db, actor, "payout.problem", "payout", p.id, { status: "pending" }, { status: "failed", reason });
  await notifyUser(ctx, p.recipientId, "payout_problem", { reason, contestId: p.contestId });
  const c = await ctx.db.select().from(contests).where(eq(contests.id, p.contestId)).get();
  if (c) await ctx.admin.payoutResolved(p, c, `⏸ Асуудалтай: ${reason}`).catch((e) => console.error(e));
  return p;
}

/**
 * Called after a user registers/changes a bank account. Attaches the account to their open payouts.
 * If a payout already had a (different) account, the change is suspicious -> the new account is locked
 * for `bank_lock_hours` before any money is sent to it.
 */
export async function onBankAccountChanged(ctx: Ctx, userId: number, newAccountId: number) {
  const s = await getSettings(ctx.db);
  const open = await ctx.db
    .select()
    .from(payouts)
    .where(and(eq(payouts.recipientId, userId), inArray(payouts.status, ["pending", "failed"])));
  if (!open.length) return;
  const hadOtherAccount = open.some((p) => p.bankAccountId && p.bankAccountId !== newAccountId && p.status === "pending");
  if (hadOtherAccount) {
    await ctx.db
      .update(bankAccounts)
      .set({ lockedUntil: ctx.now() + s.bank_lock_hours * HOUR })
      .where(eq(bankAccounts.id, newAccountId));
  }
  for (const p of open) {
    await ctx.db
      .update(payouts)
      .set({ bankAccountId: newAccountId, status: "pending", failReason: null, telegramMessageId: null })
      .where(and(eq(payouts.id, p.id), inArray(payouts.status, ["pending", "failed"])));
    if (p.telegramMessageId && p.telegramMessageId !== "sending") {
      const c = await ctx.db.select().from(contests).where(eq(contests.id, p.contestId)).get();
      if (c) await ctx.admin.payoutResolved(p, c, "🔁 Хүлээн авагч дансаа өөрчилсөн — шинэ мессеж ирнэ").catch(() => {});
    }
    await audit(ctx.db, { type: "user", id: userId }, "payout.account_changed", "payout", p.id, { bankAccountId: p.bankAccountId }, { bankAccountId: newAccountId, locked: hadOtherAccount });
    await dispatchPayout(ctx, p.id);
  }
}

/** Cron: pending payouts that could now be dispatched (account added, lock expired). */
export async function dispatchReadyPayouts(ctx: Ctx, limit = 20) {
  const rows = await ctx.db
    .select({ id: payouts.id })
    .from(payouts)
    .leftJoin(bankAccounts, eq(bankAccounts.id, payouts.bankAccountId))
    .where(
      and(
        eq(payouts.status, "pending"),
        isNull(payouts.telegramMessageId),
        sql`${payouts.bankAccountId} IS NOT NULL`,
        or(isNull(bankAccounts.lockedUntil), lte(bankAccounts.lockedUntil, ctx.now())),
      ),
    )
    .limit(limit);
  let n = 0;
  for (const r of rows) if (await dispatchPayout(ctx, r.id)) n++;
  return n;
}
