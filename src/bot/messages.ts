import { Api, InlineKeyboard, InputFile } from "grammy";
import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { payments, payouts, users, type Contest, type Payment, type Payout } from "../db/schema";
import type { Env } from "../env";
import { formatMNT } from "../lib/money";
import { nowSec, ubDateTime } from "../lib/time";
import { listAdminChats } from "../services/admin";
import type { AdminChannel, Ctx } from "../services/context";
import { payoutDetails } from "../services/payouts";

const RECEIPT_WARNING = "⚠️ Баримтын зургийг биш, БАНКНЫ АППЫН ХУУЛГЫГ шалгана уу: утга + дүн + огноо 3-уулаа таарах ёстой.";

export function paymentText(p: Payment, c: Contest, client: { name: string; phone: string | null }) {
  return [
    "💰 ШИНЭ ТӨЛБӨР — шалгана уу",
    `Уралдаан: ${c.title} (${c.paymentRefCode})`,
    `Захиалагч: ${client.name}${client.phone ? ` · ${client.phone.slice(0, 4)}xxxx` : ""}`,
    `Дүн: ${formatMNT(p.reportedAmount)}${p.reportedAmount !== p.expectedAmount ? ` (хүлээгдэж буй: ${formatMNT(p.expectedAmount)})` : ""}`,
    `Гүйлгээний утга: ${p.transferNote}`,
    `Шилжүүлсэн данс: ${p.payerBankName} · ${p.payerAccountName}`,
    `Мэдэгдсэн: ${ubDateTime(p.createdAt)}`,
    "",
    RECEIPT_WARNING,
  ].join("\n");
}

export const paymentKeyboard = (id: number) =>
  new InlineKeyboard().text("✅ Орсон", `pay:ok:${id}`).text("⚠️ Дүн зөрүүтэй", `pay:mm:${id}`).text("❌ Ороогүй", `pay:no:${id}`);

export const payoutKeyboard = (id: number) => new InlineKeyboard().text("📤 Шилжүүлсэн", `po:sent:${id}`).text("⏸ Асуудалтай", `po:hold:${id}`);

export async function payoutText(ctx: Ctx, payoutId: number) {
  const d = await payoutDetails(ctx, payoutId);
  const p = d.payout;
  const title = p.type === "refund" ? "↩️ БУЦААЛТ" : p.type === "split_prize" ? "🏆 ШАГНАЛ (тэнцүү хуваалт)" : "🏆 ЯЛАГЧИД ШИЛЖҮҮЛЭХ";
  const memo = p.type === "refund" ? `${d.contest.paymentRefCode} буцаалт` : `${d.contest.paymentRefCode} шагнал`;
  const calc = p.type === "prize" ? ` (${formatMNT(d.contest.budget)} − ${d.contest.feePercent}%)` : "";
  const lines = [
    title,
    `Уралдаан: ${d.contest.title} (${d.contest.paymentRefCode})`,
    `Хүлээн авагч: ${d.recipient.fullName ?? d.recipient.displayName ?? d.recipient.email}`,
    `Банк: ${d.account?.bankName} · ${d.accountNumber} · ${d.account?.accountHolderName}${d.account && !d.account.isVerified ? "  ⚠️ нэр профайлтай таарахгүй" : ""}`,
    `Дүн: ${formatMNT(p.amount)}${calc}`,
    `Гүйлгээний утга: ${memo}`,
    `Эцсийн хугацаа: ${ubDateTime(p.dueAt)}`,
  ];
  if (p.type === "refund") {
    // Refunds go back to the account the money came from (fraud protection).
    const pay = await ctx.db.select().from(payments).where(eq(payments.contestId, p.contestId)).all();
    const src = pay.find((x) => x.status === "confirmed" || x.status === "amount_mismatch");
    if (src) lines.push(`Төлбөр ирсэн данс: ${src.payerBankName} · ${src.payerAccountName} — ЗӨВХӨН ЭНЭ РҮҮ буцаана`);
  }
  return lines.join("\n");
}

const encodeIds = (ids: { chat: string; msg: number }[]) => ids.map((x) => `${x.chat}:${x.msg}`).join(",");
const decodeIds = (s: string | null) =>
  (s ?? "")
    .split(",")
    .filter((x) => x.includes(":"))
    .map((x) => {
      const [chat, msg] = x.split(":");
      return { chat: chat!, msg: Number(msg) };
    });

/** Real Telegram implementation of the AdminChannel used by services. */
export function telegramAdminChannel(env: Env, getCtx: () => Ctx): AdminChannel {
  const api = env.TELEGRAM_BOT_TOKEN ? new Api(env.TELEGRAM_BOT_TOKEN) : null;

  async function edit(stored: string | null, text: string) {
    if (!api) return;
    for (const { chat, msg } of decodeIds(stored)) {
      await api.editMessageText(chat, msg, text, { reply_markup: { inline_keyboard: [] } }).catch(async () => {
        // Messages with a photo use captions.
        await api.editMessageCaption(chat, msg, { caption: text.slice(0, 1024), reply_markup: { inline_keyboard: [] } }).catch(() => {});
      });
    }
  }

  return {
    async paymentReported(p, c) {
      const ctx = getCtx();
      if (!api) return console.log("[telegram disabled] payment reported", p.id);
      const client = await ctx.db.select().from(users).where(eq(users.id, p.payerId)).get();
      const text = paymentText(p, c, { name: client?.fullName ?? client?.displayName ?? client?.email ?? "?", phone: client?.phone ?? null });
      const chats = await listAdminChats(ctx, ["reviewer", "finance"]);
      const sent: { chat: string; msg: number }[] = [];
      let receipt: Uint8Array | null = null;
      if (p.receiptImageUrl && /\.(png|jpe?g|webp)$/i.test(p.receiptImageUrl)) {
        const obj = await env.PRIVATE_FILES.get(p.receiptImageUrl);
        if (obj) receipt = new Uint8Array(await obj.arrayBuffer());
      }
      for (const chat of chats) {
        const m = receipt
          ? await api.sendPhoto(chat, new InputFile(receipt, "receipt.jpg"), { caption: text, reply_markup: paymentKeyboard(p.id) })
          : await api.sendMessage(chat, text, { reply_markup: paymentKeyboard(p.id) });
        sent.push({ chat, msg: m.message_id });
      }
      await ctx.db.update(payments).set({ telegramMessageId: encodeIds(sent) }).where(eq(payments.id, p.id));
    },

    async paymentResolved(p, c, status) {
      const ctx = getCtx();
      const fresh = await ctx.db.select().from(payments).where(eq(payments.id, p.id)).get();
      const admin = fresh?.reviewedBy ? await ctx.db.select().from(users).where(eq(users.id, fresh.reviewedBy)).get() : null;
      const text = `${status} — ${admin?.displayName ?? admin?.email ?? "систем"}, ${ubDateTime(fresh?.reviewedAt ?? nowSec())}\n${c.title} (${c.paymentRefCode}) · ${formatMNT(p.reportedAmount)}`;
      await edit(fresh?.telegramMessageId ?? null, text);
    },

    async payoutReady(p) {
      const ctx = getCtx();
      if (!api) {
        console.log("[telegram disabled] payout ready", p.id);
        await ctx.db.update(payouts).set({ telegramMessageId: "disabled" }).where(eq(payouts.id, p.id));
        return;
      }
      const text = await payoutText(ctx, p.id);
      const chats = await listAdminChats(ctx, ["finance"]);
      const sent: { chat: string; msg: number }[] = [];
      for (const chat of chats) {
        const m = await api.sendMessage(chat, text, { reply_markup: payoutKeyboard(p.id) });
        sent.push({ chat, msg: m.message_id });
      }
      await ctx.db.update(payouts).set({ telegramMessageId: encodeIds(sent) || "no-admins" }).where(eq(payouts.id, p.id));
    },

    async payoutResolved(p, c, status) {
      const ctx = getCtx();
      const fresh = await ctx.db.select().from(payouts).where(eq(payouts.id, p.id)).get();
      const admin = fresh?.sentBy ? await ctx.db.select().from(users).where(eq(users.id, fresh.sentBy)).get() : null;
      await edit(
        fresh?.telegramMessageId ?? p.telegramMessageId,
        `${status} — ${admin?.displayName ?? admin?.email ?? ""} ${ubDateTime(nowSec())}\n${c.title} (${c.paymentRefCode}) · ${formatMNT(p.amount)}${fresh?.bankTransactionRef ? `\nГүйлгээ: ${fresh.bankTransactionRef}` : ""}`,
      );
    },

    async broadcast(text, levels) {
      if (!api) return console.log("[telegram disabled]", text);
      const chats = await listAdminChats(getCtx(), levels);
      for (const chat of chats) await api.sendMessage(chat, text).catch((e) => console.error(e));
    },
  };
}

