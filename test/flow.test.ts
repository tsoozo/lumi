import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { contests, payouts, entries, handovers, auditLogs, payments } from "../src/db/schema";
import type { Env } from "../src/env";
import { DAY, HOUR } from "../src/lib/time";
import * as contestSvc from "../src/services/contests";
import * as entrySvc from "../src/services/entries";
import * as handoverSvc from "../src/services/handovers";
import * as paymentSvc from "../src/services/payments";
import * as payoutSvc from "../src/services/payouts";
import * as admin from "../src/services/admin";
import { runCron } from "../src/services/lifecycle";
import * as userSvc from "../src/services/users";
import { makeTestCtx, seed, setup } from "./helpers";

let env: Env;
let dispose: () => Promise<void>;
beforeAll(async () => {
  ({ env, dispose } = await setup());
});
afterAll(async () => dispose?.());

const TABLES = ["audit_logs", "notifications", "payouts", "handovers", "entry_comments", "entries", "payments", "contest_attachments", "contests", "bank_accounts", "auth_codes", "sessions", "admin_invites", "bot_sessions", "reports", "users", "settings"];
beforeEach(async () => {
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

async function world() {
  const t = makeTestCtx(env);
  const s = await seed(t.ctx);
  return { ...t, ...s };
}

async function bankAccount(t: Awaited<ReturnType<typeof world>>, actor: { id: number | null; type: "user" }, email: string, holder: string, number = "1234567890") {
  await userSvc.requestCode(t.ctx, email);
  const code = /код: (\d{6})/.exec(t.mails.at(-1)!.text)![1]!;
  return userSvc.addBankAccount(t.ctx, actor, { bankName: "Голомт", accountNumber: number, accountHolderName: holder, code });
}

const entryInput = (uid: number) => ({ originalKey: `entries/${uid}/o.png`, watermarkedKey: `entries/${uid}/w.jpg`, originalityConfirmed: true });

async function activeContest(t: Awaited<ReturnType<typeof world>>) {
  const c = await contestSvc.createDraft(t.ctx, t.A.client, { title: "Кофе шопын лого", category: "logo", budget: 500000, submissionDays: 7, acceptNoRefund: true });
  const ready = await contestSvc.submitForPayment(t.ctx, t.A.client, c.id);
  const p = await paymentSvc.reportPayment(t.ctx, t.A.client, c.id, { reportedAmount: 500000, payerBankName: "Хаан банк", payerAccountName: "Б.Болд" });
  await paymentSvc.confirmPayment(t.ctx, t.A.reviewer, p.id, { bankTransactionRef: `TX-${c.id}` });
  return { c: await contestSvc.getContest(t.ctx, c.id), ref: ready.paymentRefCode!, payment: p };
}

describe("full money loop: payment in -> contest -> winner -> payout", () => {
  it("runs end to end with exact amounts", async () => {
    const t = await world();
    const c = await contestSvc.createDraft(t.ctx, t.A.client, { title: "Кофе шопын лого", category: "logo", budget: 500000, submissionDays: 7, acceptNoRefund: true });
    expect(c.feeAmount).toBe(25000);
    expect(c.prizeAmount).toBe(475000);

    const ready = await contestSvc.submitForPayment(t.ctx, t.A.client, c.id);
    expect(ready.status).toBe("awaiting_payment");
    expect(ready.paymentRefCode).toMatch(/^UB-[A-HJ-NP-Z2-9]{5}$/);

    const p = await paymentSvc.reportPayment(t.ctx, t.A.client, c.id, { reportedAmount: 500000, payerBankName: "Хаан банк", payerAccountName: "Б.Болд" });
    expect(t.calls.find((x) => x.kind === "paymentReported")?.id).toBe(p.id);
    expect((await contestSvc.getContest(t.ctx, c.id)).status).toBe("payment_review");

    // a normal user can't confirm
    await expect(paymentSvc.confirmPayment(t.ctx, t.A.client, p.id)).rejects.toMatchObject({ status: 403 });
    const { contest } = await paymentSvc.confirmPayment(t.ctx, t.A.reviewer, p.id, { bankTransactionRef: "KHAN-001" });
    expect(contest.status).toBe("active"); // auto approve
    expect(contest.submissionDeadline).toBe(t.now() + 7 * DAY);
    // second click / second admin
    await expect(paymentSvc.confirmPayment(t.ctx, t.A.finance, p.id)).rejects.toMatchObject({ status: 409, code: "already_resolved" });

    // entries: client can't enter own contest, max 3 per creator
    await expect(entrySvc.createEntry(t.ctx, t.A.client, c.id, entryInput(t.client.id))).rejects.toMatchObject({ status: 403 });
    const e1 = await entrySvc.createEntry(t.ctx, t.A.c1, c.id, entryInput(t.c1.id));
    await entrySvc.createEntry(t.ctx, t.A.c1, c.id, entryInput(t.c1.id));
    await entrySvc.createEntry(t.ctx, t.A.c1, c.id, entryInput(t.c1.id));
    await expect(entrySvc.createEntry(t.ctx, t.A.c1, c.id, entryInput(t.c1.id))).rejects.toMatchObject({ code: "too_many" });
    await entrySvc.createEntry(t.ctx, t.A.c2, c.id, entryInput(t.c2.id));
    // someone else's file key is refused
    await expect(entrySvc.createEntry(t.ctx, t.A.c3, c.id, entryInput(t.c1.id))).rejects.toMatchObject({ code: "file_key" });

    // blind: creator 2 sees only own; client sees all
    expect((await entrySvc.listEntries(t.ctx, t.A.c2, c.id)).length).toBe(1);
    expect((await entrySvc.listEntries(t.ctx, t.A.client, c.id)).length).toBe(4);
    expect(JSON.stringify(await entrySvc.listEntries(t.ctx, t.A.client, c.id))).not.toContain("o.png");

    // deadline passes -> selecting
    t.advance(7 * DAY + 60);
    await runCron(t.ctx);
    expect((await contestSvc.getContest(t.ctx, c.id)).status).toBe("selecting");
    await expect(entrySvc.createEntry(t.ctx, t.A.c3, c.id, entryInput(t.c3.id))).rejects.toMatchObject({ code: "closed" });

    await entrySvc.rateEntry(t.ctx, t.A.client, e1.id, 5);
    await entrySvc.setFinalists(t.ctx, t.A.client, c.id, [e1.id]);
    await entrySvc.selectWinner(t.ctx, t.A.client, c.id, e1.id);
    expect((await contestSvc.getContest(t.ctx, c.id)).status).toBe("handover");
    // unblinded after winner
    expect((await entrySvc.listEntries(t.ctx, t.A.c2, c.id)).length).toBe(4);

    const h = (await t.ctx.db.select().from(handovers).where(eq(handovers.contestId, c.id)).get())!;
    await expect(handoverSvc.sendFiles(t.ctx, t.A.c1, h.id, [`handover/${t.c1.id}/final.zip`], false)).rejects.toMatchObject({ code: "ip_agreement" });
    await handoverSvc.sendFiles(t.ctx, t.A.c1, h.id, [`handover/${t.c1.id}/final.zip`], true);
    await handoverSvc.acceptHandover(t.ctx, t.A.client, h.id);
    expect((await contestSvc.getContest(t.ctx, c.id)).status).toBe("payout_pending");

    // winner has no bank account yet -> payout exists but no admin message
    const [po] = await t.ctx.db.select().from(payouts).where(eq(payouts.contestId, c.id));
    expect(po).toMatchObject({ type: "prize", amount: 475000, status: "pending", bankAccountId: null });
    expect(t.calls.some((x) => x.kind === "payoutReady")).toBe(false);

    await bankAccount(t, t.A.c1 as never, "saraa@x.mn", "Дорж Сараа");
    expect(t.calls.find((x) => x.kind === "payoutReady")?.id).toBe(po!.id);

    // reviewer can't send money; finance needs proof
    await expect(payoutSvc.markPayoutSent(t.ctx, t.A.reviewer, po!.id, { bankTransactionRef: "X" })).rejects.toMatchObject({ status: 403 });
    await expect(payoutSvc.markPayoutSent(t.ctx, t.A.finance, po!.id, {})).rejects.toMatchObject({ code: "proof_required" });
    await payoutSvc.markPayoutSent(t.ctx, t.A.finance, po!.id, { bankTransactionRef: "GOLOMT-777" });
    await expect(payoutSvc.markPayoutSent(t.ctx, t.A.finance, po!.id, { bankTransactionRef: "again" })).rejects.toMatchObject({ status: 409 });

    expect((await contestSvc.getContest(t.ctx, c.id)).status).toBe("completed");
    const r = await admin.todayReport(t.ctx);
    expect(r.outAmount).toBe(475000);
    expect(r.feeRevenue).toBe(25000);

    const logs = await t.ctx.db.select().from(auditLogs);
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["payment.confirm", "contest.winner", "payout.mark_sent", "contest.completed"]));
  });
});

describe("payments", () => {
  it("rejects then lets the client report again; bank tx ref can't be reused", async () => {
    const t = await world();
    const { c: first } = await activeContest(t);
    const c = await contestSvc.createDraft(t.ctx, t.A.client, { title: "Лого 2", category: "logo", budget: 100000, submissionDays: 3, acceptNoRefund: true });
    await contestSvc.submitForPayment(t.ctx, t.A.client, c.id);
    const p1 = await paymentSvc.reportPayment(t.ctx, t.A.client, c.id, { reportedAmount: 100000, payerBankName: "Хаан", payerAccountName: "Болд" });
    // double click on "Шилжүүлсэн" doesn't create a second row
    await expect(paymentSvc.reportPayment(t.ctx, t.A.client, c.id, { reportedAmount: 100000, payerBankName: "Хаан", payerAccountName: "Болд" })).rejects.toMatchObject({ status: 400 });
    await paymentSvc.rejectPayment(t.ctx, t.A.reviewer, p1.id, "wrong_ref");
    expect((await contestSvc.getContest(t.ctx, c.id)).status).toBe("awaiting_payment");
    const p2 = await paymentSvc.reportPayment(t.ctx, t.A.client, c.id, { reportedAmount: 100000, payerBankName: "Хаан", payerAccountName: "Болд" });
    await expect(paymentSvc.confirmPayment(t.ctx, t.A.reviewer, p2.id, { bankTransactionRef: `TX-${first.id}` })).rejects.toMatchObject({ code: "duplicate_bank_tx" });
    // still reviewable after the failed attempt
    await paymentSvc.confirmPayment(t.ctx, t.A.reviewer, p2.id, { bankTransactionRef: "TX-NEW" });
    expect((await contestSvc.getContest(t.ctx, c.id)).status).toBe("active");
  });

  it("amount mismatch: top-up for the remainder, or refund what arrived", async () => {
    const t = await world();
    const c = await contestSvc.createDraft(t.ctx, t.A.client, { title: "Лого", category: "logo", budget: 500000, submissionDays: 7, acceptNoRefund: true });
    await contestSvc.submitForPayment(t.ctx, t.A.client, c.id);
    const p = await paymentSvc.reportPayment(t.ctx, t.A.client, c.id, { reportedAmount: 500000, payerBankName: "Хаан", payerAccountName: "Болд" });
    await paymentSvc.markAmountMismatch(t.ctx, t.A.reviewer, p.id, 300000);
    expect(await paymentSvc.amountDue(t.ctx, c.id)).toBe(200000);
    const p2 = await paymentSvc.reportPayment(t.ctx, t.A.client, c.id, { reportedAmount: 200000, payerBankName: "Хаан", payerAccountName: "Болд" });
    expect(p2.expectedAmount).toBe(200000);

    // Other contest: refund the partial amount instead
    const d = await contestSvc.createDraft(t.ctx, t.A.client, { title: "Лого B", category: "logo", budget: 500000, submissionDays: 7, acceptNoRefund: true });
    await contestSvc.submitForPayment(t.ctx, t.A.client, d.id);
    const q = await paymentSvc.reportPayment(t.ctx, t.A.client, d.id, { reportedAmount: 500000, payerBankName: "Хаан", payerAccountName: "Болд" });
    await paymentSvc.markAmountMismatch(t.ctx, t.A.reviewer, q.id, 120000);
    await paymentSvc.refundPartialPayment(t.ctx, t.A.client, d.id);
    const [refund] = await t.ctx.db.select().from(payouts).where(eq(payouts.contestId, d.id));
    expect(refund).toMatchObject({ type: "refund", amount: 120000 });
  });
});

describe("guaranteed contest rules (cron)", () => {
  it("no winner chosen: 2 reminders, +7 day grace, then split among finalists", async () => {
    const t = await world();
    const { c } = await activeContest(t);
    const e1 = await entrySvc.createEntry(t.ctx, t.A.c1, c.id, entryInput(t.c1.id));
    const e2 = await entrySvc.createEntry(t.ctx, t.A.c2, c.id, entryInput(t.c2.id));
    const e3 = await entrySvc.createEntry(t.ctx, t.A.c3, c.id, entryInput(t.c3.id));
    await entrySvc.createEntry(t.ctx, t.A.c1, c.id, entryInput(t.c1.id)); // c1 has 2 entries
    await entrySvc.setFinalists(t.ctx, t.A.client, c.id, [e1.id, e2.id, e3.id]);

    t.advance(7 * DAY + 60);
    await runCron(t.ctx); // -> selecting
    for (let i = 0; i < 7 * 4; i++) {
      t.advance(6 * HOUR); // cron runs every 15 min in prod; 6h steps are enough to cross each threshold
      await runCron(t.ctx);
    }
    const mid = await contestSvc.getContest(t.ctx, c.id);
    expect(mid.status).toBe("selecting");
    expect(mid.selectionGraceUsed).toBe(true);
    const reminders = t.mails.filter((m) => m.to === "bold@x.mn" && m.subject === "Ялагчаа сонгоно уу");
    expect(reminders.length).toBeGreaterThanOrEqual(3); // close + 2 reminders + grace notice

    t.advance(7 * DAY + 60);
    await runCron(t.ctx);
    await runCron(t.ctx); // idempotent
    expect((await contestSvc.getContest(t.ctx, c.id)).status).toBe("payout_pending");
    const ps = await t.ctx.db.select().from(payouts).where(eq(payouts.contestId, c.id));
    expect(ps.map((p) => p.amount).sort()).toEqual([158333, 158333, 158334]);
    expect(ps.reduce((s, p) => s + p.amount, 0)).toBe(475000);
    expect(ps.every((p) => p.type === "split_prize")).toBe(true);
  });

  it("fewer than 3 entries: client can extend once, or take a 100% refund", async () => {
    const t = await world();
    const { c } = await activeContest(t);
    await entrySvc.createEntry(t.ctx, t.A.c1, c.id, entryInput(t.c1.id));
    t.advance(7 * DAY + 60);
    await runCron(t.ctx);
    const ext = await entrySvc.extendContest(t.ctx, t.A.client, c.id);
    expect(ext.status).toBe("extended");
    await entrySvc.createEntry(t.ctx, t.A.c2, c.id, entryInput(t.c2.id));
    t.advance(7 * DAY + 60);
    await runCron(t.ctx);
    await expect(entrySvc.extendContest(t.ctx, t.A.client, c.id)).rejects.toMatchObject({ code: "already_extended" });
    await entrySvc.refundLowEntries(t.ctx, t.A.client, c.id);
    const [r] = await t.ctx.db.select().from(payouts).where(eq(payouts.contestId, c.id));
    expect(r).toMatchObject({ type: "refund", amount: 500000 });
    expect((await contestSvc.getContest(t.ctx, c.id)).status).toBe("refund_pending");
  });

  it("refund is refused when 3+ entries arrived (no 'didn't like any' refunds)", async () => {
    const t = await world();
    const { c } = await activeContest(t);
    for (const a of [t.A.c1, t.A.c2, t.A.c3]) await entrySvc.createEntry(t.ctx, a, c.id, entryInput(a.id!));
    t.advance(7 * DAY + 60);
    await runCron(t.ctx);
    await expect(entrySvc.refundLowEntries(t.ctx, t.A.client, c.id)).rejects.toMatchObject({ code: "enough_entries" });
  });

  it("handover auto-accepts after 3 days and payout is created", async () => {
    const t = await world();
    const { c } = await activeContest(t);
    const e1 = await entrySvc.createEntry(t.ctx, t.A.c1, c.id, entryInput(t.c1.id));
    await entrySvc.createEntry(t.ctx, t.A.c2, c.id, entryInput(t.c2.id));
    await entrySvc.createEntry(t.ctx, t.A.c3, c.id, entryInput(t.c3.id));
    t.advance(7 * DAY + 60);
    await runCron(t.ctx);
    await entrySvc.selectWinner(t.ctx, t.A.client, c.id, e1.id);
    const h = (await t.ctx.db.select().from(handovers).where(eq(handovers.contestId, c.id)).get())!;
    await handoverSvc.sendFiles(t.ctx, t.A.c1, h.id, [`handover/${t.c1.id}/f.zip`], true);
    t.advance(3 * DAY + 60);
    await runCron(t.ctx);
    expect((await t.ctx.db.select().from(handovers).where(eq(handovers.id, h.id)).get())!.status).toBe("auto_accepted");
    const [po] = await t.ctx.db.select().from(payouts).where(eq(payouts.contestId, c.id));
    expect(po!.amount).toBe(475000);
  });
});

describe("fraud protections", () => {
  it("changing the bank account while a payout is pending locks it for 48h", async () => {
    const t = await world();
    const { c } = await activeContest(t);
    const e1 = await entrySvc.createEntry(t.ctx, t.A.c1, c.id, entryInput(t.c1.id));
    for (const a of [t.A.c2, t.A.c3]) await entrySvc.createEntry(t.ctx, a, c.id, entryInput(a.id!));
    await bankAccount(t, t.A.c1 as never, "saraa@x.mn", "Дорж Сараа");
    t.advance(7 * DAY + 60);
    await runCron(t.ctx);
    await entrySvc.selectWinner(t.ctx, t.A.client, c.id, e1.id);
    const h = (await t.ctx.db.select().from(handovers).where(eq(handovers.contestId, c.id)).get())!;
    await handoverSvc.sendFiles(t.ctx, t.A.c1, h.id, [`handover/${t.c1.id}/f.zip`], true);
    await handoverSvc.acceptHandover(t.ctx, t.A.client, h.id);
    const [po] = await t.ctx.db.select().from(payouts).where(eq(payouts.contestId, c.id));
    expect(t.calls.filter((x) => x.kind === "payoutReady").length).toBe(1);

    const acct = await bankAccount(t, t.A.c1 as never, "saraa@x.mn", "Дорж Сараа", "9999999999");
    expect(acct.lockedUntil).toBe(t.now() + 48 * HOUR);
    await expect(payoutSvc.markPayoutSent(t.ctx, t.A.finance, po!.id, { bankTransactionRef: "X" })).rejects.toMatchObject({ code: "account_locked" });
    expect(t.calls.filter((x) => x.kind === "payoutReady").length).toBe(1); // no new message while locked
    t.advance(48 * HOUR + 60);
    await runCron(t.ctx);
    expect(t.calls.filter((x) => x.kind === "payoutReady").length).toBe(2);
    await payoutSvc.markPayoutSent(t.ctx, t.A.finance, po!.id, { bankTransactionRef: "OK" });
  });

  it("bank account needs a fresh email code", async () => {
    const t = await world();
    await expect(userSvc.addBankAccount(t.ctx, t.A.c1, { bankName: "Х", accountNumber: "123456789", accountHolderName: "Сараа", code: "000000" })).rejects.toMatchObject({ code: "bad_code" });
  });

  it("budget below minimum is refused; fee percent is snapshotted", async () => {
    const t = await world();
    await expect(contestSvc.createDraft(t.ctx, t.A.client, { title: "Хямд", category: "logo", budget: 49999, submissionDays: 7 })).rejects.toMatchObject({ code: "budget" });
    const c = await contestSvc.createDraft(t.ctx, t.A.client, { title: "Лого", category: "logo", budget: 100000, submissionDays: 7, acceptNoRefund: true });
    const { setSetting } = await import("../src/services/settings");
    await setSetting(t.ctx.db, "fee_percent", "10.00");
    const u = await contestSvc.updateDraft(t.ctx, t.A.client, c.id, { budget: 200000 });
    expect(u.feeAmount).toBe(10000); // still 5%
  });
});

// keep imports used
void entries;
void contests;
void payments;
