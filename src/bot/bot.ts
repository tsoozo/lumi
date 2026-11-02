import { Bot, Context, InlineKeyboard, type Filter } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { and, eq, gte, inArray } from "drizzle-orm";
import { botSessions, contests, payments, payouts, reports, type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { formatMNT } from "../lib/money";
import { ubDateTime } from "../lib/time";
import { adminByChatId, redeemAdminInvite, todayReport } from "../services/admin";
import type { Actor, Ctx } from "../services/context";
import { confirmPayment, markAmountMismatch, REJECT_REASONS, rejectPayment } from "../services/payments";
import { markPayoutProblem, markPayoutSent, payoutDetails } from "../services/payouts";
import { payoutText } from "./messages";

type BotCtx = Context & { admin?: User; actor?: Actor };

let cachedBotInfo: UserFromGetMe | undefined;

const SESSION_TTL = 10 * 60;

async function setSession(app: Ctx, chatId: string, action: string, entityId: number) {
  await app.db
    .insert(botSessions)
    .values({ chatId, action, entityId, expiresAt: app.now() + SESSION_TTL })
    .onConflictDoUpdate({ target: botSessions.chatId, set: { action, entityId, expiresAt: app.now() + SESSION_TTL } });
}
async function takeSession(app: Ctx, chatId: string) {
  const rows = await app.db.delete(botSessions).where(and(eq(botSessions.chatId, chatId), gte(botSessions.expiresAt, app.now()))).returning();
  return rows[0];
}

function errText(e: unknown) {
  if (e instanceof AppError) return e.message;
  console.error(e);
  return "Алдаа гарлаа";
}

export async function createBot(app: Ctx): Promise<Bot<BotCtx>> {
  const bot = new Bot<BotCtx>(app.env.TELEGRAM_BOT_TOKEN!, { botInfo: cachedBotInfo });
  if (!cachedBotInfo) {
    await bot.init();
    cachedBotInfo = bot.botInfo;
  }

  // /start <code> — register as admin (the only command that works for unknown chats).
  bot.command("start", async (c) => {
    const code = c.match?.trim();
    const chatId = String(c.chat.id);
    if (!code) {
      const known = await adminByChatId(app, chatId);
      return void (await c.reply(known ? `Сайн байна уу, ${known.displayName ?? known.email}. /pending /payouts /today` : "Админы кодоо илгээнэ үү: /start <код>"));
    }
    try {
      const u = await redeemAdminInvite(app, code, chatId);
      await c.reply(`✅ Админаар бүртгэгдлээ (${u.adminLevel}). Командууд: /pending /payouts /contest <код> /reports /today`);
    } catch (e) {
      await c.reply(errText(e));
    }
  });

  // Everything else: only registered admin chats. Callback data carries IDs only; services re-check permissions/state.
  bot.use(async (c, next) => {
    const chatId = c.chat?.id ?? c.callbackQuery?.message?.chat.id;
    const fromId = c.from?.id;
    if (!chatId || !fromId) return;
    // In a group the clicking user must be a registered admin themselves.
    const admin = (await adminByChatId(app, String(fromId))) ?? (c.chat?.type === "private" ? await adminByChatId(app, String(chatId)) : null);
    if (!admin) {
      if (c.callbackQuery) await c.answerCallbackQuery({ text: "Эрхгүй", show_alert: true });
      return;
    }
    c.admin = admin;
    c.actor = { type: "telegram", id: admin.id, adminLevel: admin.adminLevel as Actor["adminLevel"] };
    await next();
  });

  bot.command("pending", async (c) => {
    const rows = await app.db
      .select({ p: payments, title: contests.title, ref: contests.paymentRefCode })
      .from(payments)
      .innerJoin(contests, eq(contests.id, payments.contestId))
      .where(eq(payments.status, "reported"))
      .limit(20);
    if (!rows.length) return void (await c.reply("Шалгах төлбөр алга ✨"));
    for (const r of rows) {
      await c.reply(`💰 #${r.p.id} ${r.title} (${r.ref})\n${formatMNT(r.p.reportedAmount)} · ${r.p.payerBankName} · ${r.p.payerAccountName}\n${ubDateTime(r.p.createdAt)}`, {
        reply_markup: new InlineKeyboard().text("✅ Орсон", `pay:ok:${r.p.id}`).text("⚠️ Зөрүүтэй", `pay:mm:${r.p.id}`).text("❌ Ороогүй", `pay:no:${r.p.id}`),
      });
    }
  });

  bot.command("payouts", async (c) => {
    const rows = await app.db.select().from(payouts).where(eq(payouts.status, "pending")).limit(20);
    if (!rows.length) return void (await c.reply("Шилжүүлэх зүйл алга ✨"));
    for (const p of rows) {
      if (!p.bankAccountId) {
        await c.reply(`#${p.id} ${formatMNT(p.amount)} — хүлээн авагч данс бүртгүүлээгүй`);
        continue;
      }
      await c.reply(await payoutText(app, p.id), {
        reply_markup: new InlineKeyboard().text("📤 Шилжүүлсэн", `po:sent:${p.id}`).text("⏸ Асуудалтай", `po:hold:${p.id}`),
      });
    }
  });

  bot.command("contest", async (c) => {
    const code = c.match?.trim().toUpperCase();
    if (!code) return void (await c.reply("/contest UB-XXXXX"));
    const ct = await app.db.select().from(contests).where(eq(contests.paymentRefCode, code)).get();
    if (!ct) return void (await c.reply("Олдсонгүй"));
    await c.reply(`#${ct.id} ${ct.title}\nТөлөв: ${ct.status}\nТөсөв: ${formatMNT(ct.budget)} (шагнал ${formatMNT(ct.prizeAmount)}, шимтгэл ${formatMNT(ct.feeAmount)})\nХугацаа: ${ct.submissionDeadline ? ubDateTime(ct.submissionDeadline) : "-"}`);
  });

  bot.command("reports", async (c) => {
    const rows = await app.db.select().from(reports).where(eq(reports.status, "open")).limit(20);
    await c.reply(rows.length ? rows.map((r) => `🚩 #${r.id} уралдаан #${r.contestId}${r.entryId ? ` бүтээл #${r.entryId}` : ""}: ${r.reason}`).join("\n") : "Нээлттэй мэдээлэл алга");
  });

  bot.command("today", async (c) => {
    if (!["finance", "super"].includes(c.admin!.adminLevel!)) return void (await c.reply("Эрхгүй"));
    const r = await todayReport(app);
    await c.reply(
      `📊 Өнөөдөр\nОрсон: ${formatMNT(r.inAmount)} (${r.inCount})\nГарсан: ${formatMNT(r.outAmount)} (${r.outCount})\n5% орлого (дууссан уралдаан): ${formatMNT(r.feeRevenue)}\nШалгах: ${r.pendingPayments} · Шилжүүлэх: ${r.pendingPayouts}`,
    );
  });

  // ---------------------------------------------------------------- incoming payment buttons
  bot.callbackQuery(/^pay:(ok|mm|no):(\d+)$/, async (c) => {
    const [, act, idStr] = c.match!;
    const id = Number(idStr);
    const p = await app.db.select().from(payments).where(eq(payments.id, id)).get();
    if (!p || p.status !== "reported") return void (await c.answerCallbackQuery({ text: "Өөр админ шийдсэн байна", show_alert: true }));
    const chatId = String(c.chat!.id);
    if (act === "ok") {
      await setSession(app, chatId, "confirm_payment", id);
      await c.answerCallbackQuery();
      await c.reply(`#${id}: Банкны гүйлгээний дугаарыг бичнэ үү (давхар ашиглалтаас сэргийлнэ). Алгасах бол "-" гэж бичнэ.`, { reply_markup: { force_reply: true } });
    } else if (act === "mm") {
      await setSession(app, chatId, "mismatch_amount", id);
      await c.answerCallbackQuery();
      await c.reply(`#${id}: Хэдэн төгрөг орсон бэ? (зөвхөн тоо)`, { reply_markup: { force_reply: true } });
    } else {
      await c.answerCallbackQuery();
      const kb = new InlineKeyboard();
      for (const [code, label] of Object.entries(REJECT_REASONS)) kb.text(label, `pay:nr:${id}:${code}`).row();
      await c.reply(`#${id}: Шалтгаан сонгоно уу`, { reply_markup: kb });
    }
  });

  bot.callbackQuery(/^pay:nr:(\d+):(\w+)$/, async (c) => {
    const [, idStr, reason] = c.match!;
    try {
      await rejectPayment(app, c.actor!, Number(idStr), reason!);
      await c.answerCallbackQuery({ text: "❌ Татгалзлаа" });
      await c.editMessageText(`#${idStr}: ❌ ${REJECT_REASONS[reason!] ?? reason}`);
    } catch (e) {
      await c.answerCallbackQuery({ text: errText(e), show_alert: true });
    }
  });

  // ---------------------------------------------------------------- payout buttons (double confirmation)
  bot.callbackQuery(/^po:(sent|yes|no|hold):(\d+)$/, async (c) => {
    const [, act, idStr] = c.match!;
    const id = Number(idStr);
    const chatId = String(c.chat!.id);
    try {
      const d = await payoutDetails(app, id);
      if (d.payout.status !== "pending") return void (await c.answerCallbackQuery({ text: "Өөр админ шийдсэн байна", show_alert: true }));
      if (!["finance", "super"].includes(c.admin!.adminLevel!)) return void (await c.answerCallbackQuery({ text: "Санхүүгийн эрх шаардлагатай", show_alert: true }));
      const name = d.recipient.fullName ?? d.recipient.displayName ?? d.recipient.email;
      if (act === "sent") {
        await c.answerCallbackQuery();
        await c.reply(`Итгэлтэй байна уу? ${formatMNT(d.payout.amount)} → ${name}`, {
          reply_markup: new InlineKeyboard().text("✅ Тийм, шилжүүлсэн", `po:yes:${id}`).text("Болих", `po:no:${id}`),
        });
      } else if (act === "yes") {
        await setSession(app, chatId, "payout_ref", id);
        await c.answerCallbackQuery();
        await c.editMessageText(`#${id}: Гүйлгээний дугаар эсвэл баримтын зургаа илгээнэ үү.`);
      } else if (act === "no") {
        await c.answerCallbackQuery({ text: "Болилоо" });
        await c.deleteMessage().catch(() => {});
      } else {
        await setSession(app, chatId, "payout_hold", id);
        await c.answerCallbackQuery();
        await c.reply(`#${id}: Асуудлын шалтгааныг бичнэ үү (жишээ нь: данс буруу).`, { reply_markup: { force_reply: true } });
      }
    } catch (e) {
      await c.answerCallbackQuery({ text: errText(e), show_alert: true });
    }
  });

  // ---------------------------------------------------------------- multi-step replies
  bot.on(["message:text", "message:photo"], async (c: Filter<BotCtx, "message">) => {
    const chatId = String(c.chat.id);
    const s = await takeSession(app, chatId);
    if (!s) return;
    const text = c.message.text?.trim() ?? "";
    try {
      switch (s.action) {
        case "confirm_payment": {
          const ref = text === "-" || !text ? undefined : text;
          await confirmPayment(app, c.actor!, s.entityId, { bankTransactionRef: ref });
          await c.reply(`✅ #${s.entityId} баталгаажлаа`);
          break;
        }
        case "mismatch_amount": {
          const n = Number(text.replace(/[,\s₮]/g, ""));
          if (!Number.isSafeInteger(n)) {
            await setSession(app, chatId, s.action, s.entityId);
            return void (await c.reply("Зөвхөн тоо бичнэ үү"));
          }
          await markAmountMismatch(app, c.actor!, s.entityId, n);
          await c.reply(`⚠️ #${s.entityId}: ${formatMNT(n)} орсон гэж бүртгэлээ. Захиалагчид мэдэгдлээ.`);
          break;
        }
        case "payout_ref": {
          const photo = c.message.photo?.at(-1);
          await markPayoutSent(app, c.actor!, s.entityId, {
            bankTransactionRef: text || c.message.caption || undefined,
            proofImageUrl: photo ? `tg:${photo.file_id}` : undefined,
          });
          await c.reply(`📤 #${s.entityId} шилжүүлсэн гэж бүртгэлээ. Хүлээн авагчид мэдэгдлээ.`);
          break;
        }
        case "payout_hold": {
          if (!text) {
            await setSession(app, chatId, s.action, s.entityId);
            return void (await c.reply("Шалтгаанаа бичнэ үү"));
          }
          await markPayoutProblem(app, c.actor!, s.entityId, text);
          await c.reply(`⏸ #${s.entityId} асуудалтай гэж тэмдэглэлээ.`);
          break;
        }
      }
    } catch (e) {
      await c.reply(errText(e));
    }
  });

  return bot;
}

