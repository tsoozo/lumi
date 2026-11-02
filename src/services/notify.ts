import { eq } from "drizzle-orm";
import { notifications, users } from "../db/schema";
import type { Ctx } from "./context";

/** Messages users see on the web + by email. Keep keys stable; the SPA renders by `type`. */
const TEMPLATES: Record<string, (p: Record<string, unknown>) => { subject: string; text: string }> = {
  payment_confirmed: (p) => ({ subject: "Төлбөр баталгаажлаа", text: `"${p.title}" уралдааны төлбөр баталгаажлаа.` }),
  payment_rejected: (p) => ({ subject: "Төлбөр олдсонгүй", text: `"${p.title}" уралдааны төлбөр олдсонгүй (${p.reason}). Дахин мэдэгдэх боломжтой.` }),
  payment_mismatch: (p) => ({ subject: "Төлбөрийн дүн зөрүүтэй", text: `"${p.title}": ${p.received}₮ орсон, ${p.expected}₮ байх ёстой. Дутууг нэмж шилжүүлэх эсвэл буцаалт авах боломжтой.` }),
  contest_published: (p) => ({ subject: "Уралдаан нийтлэгдлээ", text: `"${p.title}" уралдаан нийтлэгдэж бүтээл хүлээн авч эхэллээ.` }),
  contest_rejected: (p) => ({ subject: "Уралдаан татгалзагдлаа", text: `"${p.title}" нийтлэгдэхээс татгалзлаа: ${p.reason}. Төлбөрийг 100% буцаана.` }),
  submission_closed: (p) => ({ subject: "Ялагчаа сонгоно уу", text: `"${p.title}" уралдааны бүтээл хүлээн авах хугацаа дууслаа. ${p.days} хоногт ялагчаа сонгоно уу.` }),
  low_entries: (p) => ({ subject: "Бүтээл цөөн ирлээ", text: `"${p.title}" уралдаанд ${p.count} бүтээл ирсэн. Хугацаа сунгах, буцаалт авах эсвэл ялагч сонгох боломжтой.` }),
  selection_reminder: (p) => ({ subject: "Ялагчаа сонгоно уу", text: `"${p.title}" уралдааны ялагч сонгох хугацаа дуусч байна. Сонгоогүй бол шагналыг оролцогчдод тэнцүү хуваана.` }),
  you_won: (p) => ({ subject: "Та яллаа! 🏆", text: `"${p.title}" уралдаанд таны бүтээл яллаа. ${p.days} хоногт эх файлаа илгээнэ үү.` }),
  handover_files_sent: (p) => ({ subject: "Эх файл ирлээ", text: `"${p.title}" уралдааны эх файл ирлээ. Шалгаад хүлээн авна уу.` }),
  bank_account_required: (p) => ({ subject: "Банкны данс бүртгүүлнэ үү", text: `${p.amount}₮ хүлээн авахын тулд банкны дансаа бүртгүүлнэ үү.` }),
  split_prize: (p) => ({ subject: "Шагнал хуваагдлаа", text: `"${p.title}" уралдааны захиалагч ялагч сонгоогүй тул шагналыг тэнцүү хуваав. Таны хувь: ${p.amount}₮.` }),
  split_prize_client: (p) => ({ subject: "Шагнал хуваагдлаа", text: `"${p.title}" уралдаанд ялагч сонгогдоогүй тул шагналыг оролцогчдод тэнцүү хуваав. Та аль ч бүтээлийг ашиглах эрхгүй.` }),
  payout_sent: (p) => ({ subject: "Мөнгө шилжлээ", text: `${p.amount}₮ таны данс руу шилжлээ. Гүйлгээ: ${p.ref ?? "-"}` }),
  payout_problem: (p) => ({ subject: "Дансаа шалгана уу", text: `Шилжүүлэг амжилтгүй: ${p.reason}. Дансны мэдээллээ шалгана уу.` }),
  refund_started: (p) => ({ subject: "Буцаалт", text: `"${p.title}" уралдааны ${p.amount}₮ буцаалт эхэллээ.` }),
  entry_removed: (p) => ({ subject: "Бүтээл хасагдлаа", text: `Таны бүтээл хасагдлаа: ${p.reason}` }),
};

export async function notifyUser(ctx: Ctx, userId: number, type: string, payload: Record<string, unknown>) {
  await ctx.db.insert(notifications).values({ userId, type, payload: JSON.stringify(payload) });
  const tpl = TEMPLATES[type];
  if (!tpl) return;
  const u = await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get();
  if (!u) return;
  const { subject, text } = tpl(payload);
  try {
    await ctx.mailer.send(u.email, subject, `${text}\n\n${ctx.env.APP_URL}`);
  } catch (e) {
    console.error("email failed", e); // notification row is the source of truth
  }
}
