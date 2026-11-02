import { and, asc, count, eq, inArray, or } from "drizzle-orm";
import { contests, entries, entryComments, handovers, users, type Contest, type Entry } from "../db/schema";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { DAY } from "../lib/time";
import { audit } from "./audit";
import type { Actor, Ctx } from "./context";
import { ACCEPTING_ENTRIES, transition } from "./contestState";
import { countActiveEntries, getContest } from "./contests";
import { notifyUser } from "./notify";
import { createPayouts } from "./payouts";
import { getSettings } from "./settings";

/** Once a winner is chosen, entries are no longer blind. */
const UNBLINDED: Contest["status"][] = ["handover", "payout_pending", "completed"];

export interface EntryInput {
  title?: string;
  description?: string;
  originalKey: string; // PRIVATE_FILES, uploaded directly via presigned URL
  watermarkedKey: string; // PUBLIC_FILES, watermark applied in the creator's browser (canvas)
  previewKey?: string; // PUBLIC_FILES, low-res thumbnail
  originalityConfirmed: boolean; // "Энэ миний өөрийн бүтээл"
}

function checkKeys(actorId: number, i: Partial<EntryInput>) {
  const own = (k?: string) => !k || k.startsWith(`entries/${actorId}/`);
  if (!own(i.originalKey) || !own(i.watermarkedKey) || !own(i.previewKey)) throw badRequest("file_key", "Файлын түлхүүр буруу");
}

async function assertAccepting(ctx: Ctx, c: Contest) {
  if (!ACCEPTING_ENTRIES.includes(c.status) || !c.submissionDeadline || c.submissionDeadline <= ctx.now()) {
    throw badRequest("closed", "Энэ уралдаан бүтээл хүлээн авахгүй байна");
  }
}

export async function createEntry(ctx: Ctx, actor: Actor, contestId: number, input: EntryInput): Promise<Entry> {
  const c = await getContest(ctx, contestId);
  await assertAccepting(ctx, c);
  if (c.clientId === actor.id) throw forbidden("Өөрийн уралдаанд бүтээл оруулах боломжгүй");
  if (!input.originalityConfirmed) throw badRequest("originality", "\"Энэ миний өөрийн бүтээл\" гэдгийг баталгаажуулна уу");
  if (!input.originalKey || !input.watermarkedKey) throw badRequest("files", "Файлаа оруулна уу");
  checkKeys(actor.id!, input);
  const s = await getSettings(ctx.db);
  const mine = await ctx.db
    .select({ n: count() })
    .from(entries)
    .where(and(eq(entries.contestId, contestId), eq(entries.creatorId, actor.id!), eq(entries.status, "active")))
    .get();
  if ((mine?.n ?? 0) >= s.max_entries_per_creator) {
    throw badRequest("too_many", `Нэг уралдаанд хамгийн ихдээ ${s.max_entries_per_creator} бүтээл оруулна`);
  }
  const [e] = await ctx.db
    .insert(entries)
    .values({
      contestId,
      creatorId: actor.id!,
      title: (input.title ?? "").slice(0, 120),
      description: (input.description ?? "").slice(0, 2000),
      originalFileUrl: input.originalKey,
      watermarkedUrl: input.watermarkedKey,
      previewUrl: input.previewKey ?? null,
      originalityConfirmedAt: ctx.now(),
    })
    .returning();
  await audit(ctx.db, actor, "entry.create", "entry", e!.id, undefined, { contestId });
  return e!;
}

async function ownEntry(ctx: Ctx, actor: Actor, entryId: number) {
  const e = await ctx.db.select().from(entries).where(eq(entries.id, entryId)).get();
  if (!e) throw notFound("Бүтээл олдсонгүй");
  if (e.creatorId !== actor.id) throw forbidden();
  if (e.status !== "active") throw badRequest("not_active", "Энэ бүтээл идэвхгүй байна");
  const c = await getContest(ctx, e.contestId);
  await assertAccepting(ctx, c);
  return e;
}

export async function updateEntry(ctx: Ctx, actor: Actor, entryId: number, input: Partial<EntryInput>) {
  const e = await ownEntry(ctx, actor, entryId);
  checkKeys(actor.id!, input);
  const [u] = await ctx.db
    .update(entries)
    .set({
      title: input.title?.slice(0, 120) ?? e.title,
      description: input.description?.slice(0, 2000) ?? e.description,
      originalFileUrl: input.originalKey ?? e.originalFileUrl,
      watermarkedUrl: input.watermarkedKey ?? e.watermarkedUrl,
      previewUrl: input.previewKey ?? e.previewUrl,
      updatedAt: ctx.now(),
    })
    .where(eq(entries.id, entryId))
    .returning();
  return u!;
}

/** DELETE = withdraw (row is kept). */
export async function withdrawEntry(ctx: Ctx, actor: Actor, entryId: number) {
  await ownEntry(ctx, actor, entryId);
  const [u] = await ctx.db
    .update(entries)
    .set({ status: "withdrawn", isFinalist: false, updatedAt: ctx.now() })
    .where(and(eq(entries.id, entryId), eq(entries.status, "active")))
    .returning();
  await audit(ctx.db, actor, "entry.withdraw", "entry", entryId);
  return u!;
}

/** Public-safe projection: never exposes original_file_url. */
function project(e: Entry & { creatorName?: string | null }, showCreator: boolean) {
  return {
    id: e.id,
    contestId: e.contestId,
    title: e.title,
    description: e.description,
    watermarkedUrl: e.watermarkedUrl,
    previewUrl: e.previewUrl,
    rating: e.rating,
    isFinalist: e.isFinalist,
    isWinner: e.isWinner,
    status: e.status,
    createdAt: e.createdAt,
    creatorId: showCreator ? e.creatorId : undefined,
    creatorName: showCreator ? e.creatorName : undefined,
  };
}

/**
 * Blind mode: the client sees all entries (watermarked), a creator sees only their own,
 * until the winner is chosen. Then everyone sees all active entries.
 */
export async function listEntries(ctx: Ctx, viewer: Actor | null, contestId: number) {
  const c = await getContest(ctx, contestId);
  const isClient = viewer?.id === c.clientId;
  const isAdmin = viewer?.type === "admin";
  const unblinded = UNBLINDED.includes(c.status);
  const base = ctx.db
    .select({ e: entries, creatorName: users.displayName })
    .from(entries)
    .innerJoin(users, eq(users.id, entries.creatorId));
  let rows: { e: Entry; creatorName: string | null }[];
  if (isClient || isAdmin || unblinded) {
    rows = await base.where(and(eq(entries.contestId, contestId), eq(entries.status, "active"))).orderBy(asc(entries.id));
  } else if (viewer?.id) {
    rows = await base.where(and(eq(entries.contestId, contestId), eq(entries.creatorId, viewer.id), inArray(entries.status, ["active", "removed"]))).orderBy(asc(entries.id));
  } else {
    rows = [];
  }
  return rows.map((r) => project({ ...r.e, creatorName: r.creatorName }, true));
}

async function clientEntry(ctx: Ctx, actor: Actor, entryId: number) {
  const e = await ctx.db.select().from(entries).where(eq(entries.id, entryId)).get();
  if (!e || e.status !== "active") throw notFound("Бүтээл олдсонгүй");
  const c = await getContest(ctx, e.contestId);
  if (c.clientId !== actor.id) throw forbidden();
  return { e, c };
}

export async function rateEntry(ctx: Ctx, actor: Actor, entryId: number, stars: number) {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw badRequest("stars", "1–5 од");
  await clientEntry(ctx, actor, entryId);
  await ctx.db.update(entries).set({ rating: stars }).where(eq(entries.id, entryId));
}

/** Private comments between the client and the entry's creator. */
export async function addComment(ctx: Ctx, actor: Actor, entryId: number, body: string) {
  const e = await ctx.db.select().from(entries).where(eq(entries.id, entryId)).get();
  if (!e) throw notFound();
  const c = await getContest(ctx, e.contestId);
  if (actor.id !== c.clientId && actor.id !== e.creatorId) throw forbidden();
  if (!body?.trim() || body.length > 2000) throw badRequest("body", "Сэтгэгдэл 1–2000 тэмдэгт");
  const [r] = await ctx.db.insert(entryComments).values({ entryId, authorId: actor.id!, body: body.trim() }).returning();
  return r!;
}

export async function listComments(ctx: Ctx, actor: Actor, entryId: number) {
  const e = await ctx.db.select().from(entries).where(eq(entries.id, entryId)).get();
  if (!e) throw notFound();
  const c = await getContest(ctx, e.contestId);
  if (actor.id !== c.clientId && actor.id !== e.creatorId) throw forbidden();
  return ctx.db.select().from(entryComments).where(eq(entryComments.entryId, entryId)).orderBy(asc(entryComments.id));
}

// ------------------------------------------------------------------ selection

export async function setFinalists(ctx: Ctx, actor: Actor, contestId: number, entryIds: number[]) {
  const c = await getContest(ctx, contestId);
  if (c.clientId !== actor.id) throw forbidden();
  if (!["active", "extended", "selecting"].includes(c.status)) throw badRequest("invalid_state", "Энэ үед эцсийн шат сонгох боломжгүй");
  const s = await getSettings(ctx.db);
  const ids = [...new Set(entryIds)];
  if (ids.length > s.max_finalists) throw badRequest("too_many", `Эцсийн шатанд ${s.max_finalists} хүртэл бүтээл`);
  if (ids.length) {
    const valid = await ctx.db
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.contestId, contestId), eq(entries.status, "active"), inArray(entries.id, ids)));
    if (valid.length !== ids.length) throw badRequest("entry", "Бүтээл буруу");
  }
  await ctx.db.batch([
    ctx.db.update(entries).set({ isFinalist: false }).where(eq(entries.contestId, contestId)),
    ctx.db.update(entries).set({ isFinalist: true }).where(and(eq(entries.contestId, contestId), inArray(entries.id, ids.length ? ids : [-1]))),
  ]);
  await audit(ctx.db, actor, "contest.finalists", "contest", contestId, undefined, { entryIds: ids });
}

/** The client picks exactly one winner -> handover starts. */
export async function selectWinner(ctx: Ctx, actor: Actor, contestId: number, entryId: number) {
  const c = await getContest(ctx, contestId);
  if (c.clientId !== actor.id) throw forbidden();
  if (c.status !== "selecting") throw badRequest("invalid_state", "Ялагч сонгох шат биш байна");
  const e = await ctx.db.select().from(entries).where(and(eq(entries.id, entryId), eq(entries.contestId, contestId), eq(entries.status, "active"))).get();
  if (!e) throw badRequest("entry", "Бүтээл буруу");
  const s = await getSettings(ctx.db);
  const next = await transition(ctx.db, contestId, ["selecting"], "handover");
  await ctx.db.batch([
    ctx.db.update(entries).set({ isWinner: true }).where(eq(entries.id, entryId)),
    ctx.db.insert(handovers).values({ contestId, entryId, filesDeadline: ctx.now() + s.handover_files_days * DAY }).onConflictDoNothing(),
  ]);
  await audit(ctx.db, actor, "contest.winner", "contest", contestId, { status: c.status }, { status: next.status, entryId });
  await notifyUser(ctx, e.creatorId, "you_won", { title: c.title, days: s.handover_files_days, contestId });
  return next;
}

/** Fewer than min_entries arrived: the client may extend once by `extend_days`. */
export async function extendContest(ctx: Ctx, actor: Actor, contestId: number) {
  const c = await getContest(ctx, contestId);
  if (c.clientId !== actor.id) throw forbidden();
  const s = await getSettings(ctx.db);
  if (c.status !== "selecting") throw badRequest("invalid_state", "Энэ үед сунгах боломжгүй");
  if (c.extendedCount >= 1) throw badRequest("already_extended", "Уралдааныг нэг л удаа сунгана");
  if ((await countActiveEntries(ctx, contestId)) >= s.min_entries) throw badRequest("enough_entries", "Хангалттай бүтээл ирсэн тул сунгах шаардлагагүй");
  const next = await transition(ctx.db, contestId, ["selecting"], "extended", {
    submissionDeadline: ctx.now() + s.extend_days * DAY,
    selectionDeadline: null,
    extendedCount: c.extendedCount + 1,
  });
  await audit(ctx.db, actor, "contest.extend", "contest", contestId, { status: c.status }, { status: next.status });
  return next;
}

/** Fewer than min_entries arrived: the client may take a 100% refund instead. */
export async function refundLowEntries(ctx: Ctx, actor: Actor, contestId: number) {
  const c = await getContest(ctx, contestId);
  if (c.clientId !== actor.id) throw forbidden();
  const s = await getSettings(ctx.db);
  if (c.status !== "selecting") throw badRequest("invalid_state", "Энэ үед буцаалт авах боломжгүй");
  if ((await countActiveEntries(ctx, contestId)) >= s.min_entries) {
    throw badRequest("enough_entries", "Хангалттай бүтээл ирсэн тул буцаалт хийгдэхгүй (дүрмийн дагуу)");
  }
  return startFullRefund(ctx, actor, c, "low_entries");
}

export async function startFullRefund(ctx: Ctx, actor: Actor, c: Contest, reason: string) {
  const next = await transition(ctx.db, c.id, [c.status], "refund_pending");
  await audit(ctx.db, actor, "contest.refund", "contest", c.id, { status: c.status }, { status: next.status, reason });
  await createPayouts(ctx, c.id, "refund", [{ recipientId: c.clientId, amount: c.budget }]);
  await notifyUser(ctx, c.clientId, "refund_started", { title: c.title, amount: c.budget, contestId: c.id });
  return next;
}

export async function removeEntry(ctx: Ctx, actor: Actor, entryId: number, reason: string) {
  if (actor.type !== "admin" && actor.type !== "telegram") throw forbidden();
  const [e] = await ctx.db
    .update(entries)
    .set({ status: "removed", removedReason: reason.slice(0, 500), isFinalist: false, updatedAt: ctx.now() })
    .where(and(eq(entries.id, entryId), or(eq(entries.status, "active"), eq(entries.status, "withdrawn"))))
    .returning();
  if (!e) throw notFound();
  await audit(ctx.db, actor, "entry.remove", "entry", entryId, undefined, { reason });
  await notifyUser(ctx, e.creatorId, "entry_removed", { reason, contestId: e.contestId });
  return e;
}

