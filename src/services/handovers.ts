import { and, eq, inArray } from "drizzle-orm";
import { entries, handovers, type Handover } from "../db/schema";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { DAY } from "../lib/time";
import { audit } from "./audit";
import { SYSTEM, type Actor, type Ctx } from "./context";
import { transition } from "./contestState";
import { getContest } from "./contests";
import { notifyUser } from "./notify";
import { createPayouts } from "./payouts";
import { getSettings } from "./settings";

async function load(ctx: Ctx, id: number) {
  const h = await ctx.db.select().from(handovers).where(eq(handovers.id, id)).get();
  if (!h) throw notFound("Хүлээлгэн өгөлт олдсонгүй");
  const e = await ctx.db.select().from(entries).where(eq(entries.id, h.entryId)).get();
  const c = await getContest(ctx, h.contestId);
  return { h, e: e!, c };
}

export async function getHandoverForUser(ctx: Ctx, actor: Actor, id: number) {
  const { h, e, c } = await load(ctx, id);
  const role = actor.id === c.clientId ? "client" : actor.id === e.creatorId ? "creator" : actor.type === "admin" ? "admin" : null;
  if (!role) throw forbidden();
  const files: string[] = h.finalFilesUrl ? JSON.parse(h.finalFilesUrl) : [];
  return {
    handover: { ...h, finalFilesUrl: undefined },
    // The client sees the final files only after the winner sent them.
    files: role === "client" && h.status === "waiting_files" ? [] : files,
    contest: { id: c.id, title: c.title, prizeAmount: c.prizeAmount, status: c.status },
    entry: { id: e.id, title: e.title, watermarkedUrl: e.watermarkedUrl },
    role,
  };
}

/** The winner uploads final source files (direct to private R2) and agrees to the IP transfer terms. */
export async function sendFiles(ctx: Ctx, actor: Actor, id: number, keys: string[], agreeIp: boolean) {
  const { h, e, c } = await load(ctx, id);
  if (actor.id !== e.creatorId) throw forbidden();
  if (!agreeIp && !h.ipAgreementCreatorAt) throw badRequest("ip_agreement", "Зохиогчийн эрх шилжүүлэх гэрээг зөвшөөрнө үү");
  if (!keys.length || keys.length > 20) throw badRequest("files", "1–20 файл");
  for (const k of keys) if (!k.startsWith(`handover/${actor.id}/`)) throw badRequest("file_key", "Файлын түлхүүр буруу");
  const s = await getSettings(ctx.db);
  const rows = await ctx.db
    .update(handovers)
    .set({
      finalFilesUrl: JSON.stringify(keys),
      status: "files_sent",
      filesSentAt: ctx.now(),
      acceptDeadline: ctx.now() + s.handover_accept_days * DAY,
      ipAgreementCreatorAt: h.ipAgreementCreatorAt ?? ctx.now(),
    })
    .where(and(eq(handovers.id, id), inArray(handovers.status, ["waiting_files", "files_sent"])))
    .returning();
  if (!rows.length) throw conflict("invalid_state", "Хүлээлгэн өгөлт аль хэдийн дууссан байна");
  await audit(ctx.db, actor, "handover.files_sent", "handover", id, { status: h.status }, { status: "files_sent", files: keys.length });
  await notifyUser(ctx, c.clientId, "handover_files_sent", { title: c.title, handoverId: id, contestId: c.id });
  return rows[0]!;
}

export async function agreeIp(ctx: Ctx, actor: Actor, id: number) {
  const { h, e, c } = await load(ctx, id);
  if (actor.id === c.clientId) {
    await ctx.db.update(handovers).set({ ipAgreementClientAt: h.ipAgreementClientAt ?? ctx.now() }).where(eq(handovers.id, id));
  } else if (actor.id === e.creatorId) {
    await ctx.db.update(handovers).set({ ipAgreementCreatorAt: h.ipAgreementCreatorAt ?? ctx.now() }).where(eq(handovers.id, id));
  } else throw forbidden();
  await audit(ctx.db, actor, "handover.agree_ip", "handover", id);
}

/** Client accepts the files -> prize payout is created (95%). */
export async function acceptHandover(ctx: Ctx, actor: Actor, id: number) {
  const { h, c } = await load(ctx, id);
  if (actor.id !== c.clientId) throw forbidden();
  if (h.status !== "files_sent") throw badRequest("invalid_state", "Эх файл ирээгүй байна");
  return completeHandover(ctx, actor, h, "accepted");
}

export async function completeHandover(ctx: Ctx, actor: Actor, h: Handover, status: "accepted" | "auto_accepted") {
  const rows = await ctx.db
    .update(handovers)
    .set({ status, acceptedAt: ctx.now(), ipAgreementClientAt: h.ipAgreementClientAt ?? ctx.now() })
    .where(and(eq(handovers.id, h.id), eq(handovers.status, "files_sent")))
    .returning();
  if (!rows.length) return null; // already completed (idempotent for cron)
  const c = await getContest(ctx, h.contestId);
  const e = await ctx.db.select().from(entries).where(eq(entries.id, h.entryId)).get();
  const next = await transition(ctx.db, c.id, ["handover"], "payout_pending");
  await audit(ctx.db, actor ?? SYSTEM, `handover.${status}`, "handover", h.id, { status: h.status }, { status, contestStatus: next.status });
  await createPayouts(ctx, c.id, "prize", [{ recipientId: e!.creatorId, amount: c.prizeAmount }]);
  return rows[0]!;
}
