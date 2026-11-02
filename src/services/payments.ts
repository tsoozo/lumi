import { and, desc, eq, inArray, sum } from "drizzle-orm";
import { contests, payments, users, type Payment } from "../db/schema";
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from "../lib/errors";
import { audit } from "./audit";
import { requireAdminLevel, type Actor, type Ctx } from "./context";
import { transition } from "./contestState";
import { getContest, publishFields } from "./contests";
import { notifyUser } from "./notify";
import { createPayouts } from "./payouts";
import { getSettings } from "./settings";

/** Sum already received on this contest from payments marked "amount_mismatch" (partial transfers). */
async function partialReceived(ctx: Ctx, contestId: number): Promise<number> {
  const r = await ctx.db
    .select({ s: sum(payments.receivedAmount) })
    .from(payments)
    .where(and(eq(payments.contestId, contestId), eq(payments.status, "amount_mismatch")))
    .get();
  return Number(r?.s ?? 0);
}

/** What the client still has to transfer (budget minus partial amounts already received). */
export async function amountDue(ctx: Ctx, contestId: number): Promise<number> {
  const c = await getContest(ctx, contestId);
  return c.budget - (await partialReceived(ctx, contestId));
}

export interface ReportPaymentInput {
  reportedAmount: number;
  payerBankName: string;
  payerAccountName: string;
  receiptKey?: string; // PRIVATE_FILES key uploaded via presign
}

/** Client pressed "Шилжүүлсэн". awaiting_payment -> payment_review, admins get Telegram message 1. */
export async function reportPayment(ctx: Ctx, actor: Actor, contestId: number, input: ReportPaymentInput): Promise<Payment> {
  const c = await getContest(ctx, contestId);
  if (c.clientId !== actor.id) throw forbidden();
  if (c.status !== "awaiting_payment") throw badRequest("invalid_state", "Энэ уралдаан төлбөр хүлээгээгүй байна");
  if (!Number.isSafeInteger(input.reportedAmount) || input.reportedAmount <= 0) throw badRequest("amount", "Дүн буруу");
  if (!input.payerBankName?.trim() || !input.payerAccountName?.trim()) throw badRequest("payer", "Банк, данс эзэмшигчийн нэрээ оруулна уу");
  if (input.receiptKey && !input.receiptKey.startsWith(`receipts/${actor.id}/`)) throw badRequest("receipt", "Баримтын файл буруу");

  const expected = await amountDue(ctx, contestId);
  // Move the contest first (guarded) so a double click can't create two payment rows.
  const updated = await transition(ctx.db, contestId, ["awaiting_payment"], "payment_review");
  const [p] = await ctx.db
    .insert(payments)
    .values({
      contestId,
      payerId: actor.id!,
      expectedAmount: expected,
      reportedAmount: input.reportedAmount,
      payerBankName: input.payerBankName.trim().slice(0, 100),
      payerAccountName: input.payerAccountName.trim().slice(0, 100),
      transferNote: c.paymentRefCode!,
      receiptImageUrl: input.receiptKey ?? null,
    })
    .returning();
  await audit(ctx.db, actor, "payment.report", "payment", p!.id, undefined, { amount: input.reportedAmount, expected });
  try {
    await ctx.admin.paymentReported(p!, updated);
  } catch (e) {
    console.error("telegram send failed; cron reminder will retry", e);
  }
  return p!;
}

async function claimPayment(ctx: Ctx, id: number, set: Partial<typeof payments.$inferInsert>): Promise<Payment> {
  let rows: Payment[];
  try {
    rows = await ctx.db
      .update(payments)
      .set(set)
      .where(and(eq(payments.id, id), eq(payments.status, "reported")))
      .returning();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw conflict("duplicate_bank_tx", "Энэ банкны гүйлгээний дугаарыг өөр төлбөрт аль хэдийн ашигласан байна");
    }
    throw e;
  }
  if (!rows.length) {
    const p = await ctx.db.select().from(payments).where(eq(payments.id, id)).get();
    if (!p) throw notFound("Төлбөр олдсонгүй");
    const who = p.reviewedBy ? await ctx.db.select({ n: users.displayName, e: users.email }).from(users).where(eq(users.id, p.reviewedBy)).get() : null;
    throw conflict("already_resolved", `Өөр админ (${who?.n ?? who?.e ?? "?"}) аль хэдийн шийдсэн байна: ${p.status}`);
  }
  return rows[0]!;
}

/**
 * ✅ "Орсон". Same function for Telegram button and web admin panel.
 * Admin must have matched ref code + amount + date in the BANK APP (not the receipt image).
 */
export async function confirmPayment(ctx: Ctx, actor: Actor, paymentId: number, opts: { bankTransactionRef?: string } = {}) {
  requireAdminLevel(actor, ["reviewer", "finance"]);
  const p = await claimPayment(ctx, paymentId, {
    status: "confirmed",
    reviewedBy: actor.id,
    reviewedAt: ctx.now(),
    bankTransactionRef: opts.bankTransactionRef?.trim() || null,
  });
  await ctx.db.update(payments).set({ receivedAmount: p.expectedAmount }).where(eq(payments.id, p.id));
  const s = await getSettings(ctx.db);
  const c = await getContest(ctx, p.contestId);
  const next = s.auto_approve_contests
    ? await transition(ctx.db, c.id, ["payment_review"], "active", publishFields(c, ctx.now()))
    : await transition(ctx.db, c.id, ["payment_review"], "pending_approval");
  await audit(ctx.db, actor, "payment.confirm", "payment", p.id, { status: "reported" }, { status: "confirmed", contestStatus: next.status, bankTx: p.bankTransactionRef });
  await notifyUser(ctx, c.clientId, "payment_confirmed", { title: c.title, contestId: c.id });
  if (next.status === "active") await notifyUser(ctx, c.clientId, "contest_published", { title: c.title, contestId: c.id });
  await ctx.admin.paymentResolved(p, next, `✅ Баталгаажсан`).catch((e) => console.error(e));
  return { payment: p, contest: next };
}

export const REJECT_REASONS: Record<string, string> = {
  not_found: "Төлбөр ороогүй",
  wrong_ref: "Гүйлгээний утга буруу",
  other: "Бусад",
};

/** ❌ "Ороогүй". Contest goes back to awaiting_payment, the client can report again. */
export async function rejectPayment(ctx: Ctx, actor: Actor, paymentId: number, reasonCode: string, note?: string) {
  requireAdminLevel(actor, ["reviewer", "finance"]);
  const reason = (REJECT_REASONS[reasonCode] ?? REJECT_REASONS.other) + (note ? `: ${note}` : "");
  const p = await claimPayment(ctx, paymentId, { status: "rejected", reviewedBy: actor.id, reviewedAt: ctx.now(), rejectReason: reason });
  const c = await transition(ctx.db, p.contestId, ["payment_review"], "awaiting_payment");
  await audit(ctx.db, actor, "payment.reject", "payment", p.id, { status: "reported" }, { status: "rejected", reason });
  await notifyUser(ctx, c.clientId, "payment_rejected", { title: c.title, reason, contestId: c.id });
  await ctx.admin.paymentResolved(p, c, `❌ Ороогүй (${reason})`).catch((e) => console.error(e));
  return p;
}

/**
 * ⚠️ "Дүн зөрүүтэй". Admin types how much actually arrived. Contest goes back to awaiting_payment with the
 * remaining amount due; the client tops up (new report) or requests a refund of what arrived.
 */
export async function markAmountMismatch(ctx: Ctx, actor: Actor, paymentId: number, receivedAmount: number) {
  requireAdminLevel(actor, ["reviewer", "finance"]);
  if (!Number.isSafeInteger(receivedAmount) || receivedAmount < 0) throw badRequest("amount", "Дүн буруу");
  const cur = await ctx.db.select().from(payments).where(eq(payments.id, paymentId)).get();
  if (!cur) throw notFound();
  if (receivedAmount >= cur.expectedAmount) {
    throw badRequest("not_mismatch", "Орсон дүн хүлээгдэж буй дүнгээс их/тэнцүү бол \"Орсон\" товчийг дарна уу");
  }
  const p = await claimPayment(ctx, paymentId, {
    status: "amount_mismatch",
    receivedAmount,
    reviewedBy: actor.id,
    reviewedAt: ctx.now(),
  });
  const c = await transition(ctx.db, p.contestId, ["payment_review"], "awaiting_payment");
  await audit(ctx.db, actor, "payment.mismatch", "payment", p.id, { status: "reported" }, { status: "amount_mismatch", receivedAmount });
  await notifyUser(ctx, c.clientId, "payment_mismatch", { title: c.title, received: receivedAmount, expected: p.expectedAmount, contestId: c.id });
  await ctx.admin.paymentResolved(p, c, `⚠️ Дүн зөрүүтэй: ${receivedAmount}₮ орсон`).catch((e) => console.error(e));
  return p;
}

/** Client gives up after a partial transfer: refund exactly what arrived. */
export async function refundPartialPayment(ctx: Ctx, actor: Actor, contestId: number) {
  const c = await getContest(ctx, contestId);
  if (c.clientId !== actor.id) throw forbidden();
  const received = await partialReceived(ctx, contestId);
  if (received <= 0) throw badRequest("nothing_to_refund", "Буцаах дүн алга");
  const next = await transition(ctx.db, contestId, ["awaiting_payment"], "refund_pending");
  await audit(ctx.db, actor, "contest.partial_refund", "contest", contestId, { status: c.status }, { status: next.status, amount: received });
  await createPayouts(ctx, contestId, "refund", [{ recipientId: c.clientId, amount: received }]);
  await notifyUser(ctx, c.clientId, "refund_started", { title: c.title, amount: received, contestId });
  return next;
}

export async function listContestPayments(ctx: Ctx, contestId: number) {
  return ctx.db.select().from(payments).where(eq(payments.contestId, contestId)).orderBy(desc(payments.id));
}

export async function listPaymentsByStatus(ctx: Ctx, statuses: Payment["status"][]) {
  return ctx.db
    .select({ payment: payments, contest: { id: contests.id, title: contests.title, ref: contests.paymentRefCode, budget: contests.budget } })
    .from(payments)
    .innerJoin(contests, eq(contests.id, payments.contestId))
    .where(inArray(payments.status, statuses))
    .orderBy(desc(payments.id))
    .limit(100);
}
