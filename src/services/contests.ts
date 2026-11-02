import { and, desc, eq, gte, inArray, sql, count } from "drizzle-orm";
import { contestAttachments, contests, entries, type Contest } from "../db/schema";
import { badRequest, forbidden, isUniqueViolation, notFound } from "../lib/errors";
import { calcFee } from "../lib/money";
import { generateRefCode } from "../lib/refcode";
import { DAY } from "../lib/time";
import { audit } from "./audit";
import type { Actor, Ctx } from "./context";
import { transition } from "./contestState";
import { getSettings } from "./settings";

export const CATEGORIES = ["logo", "brand", "web", "app", "print", "packaging", "illustration", "social", "other"] as const;

export interface ContestInput {
  title: string;
  category: string;
  description?: string;
  requirements?: string;
  deliverableFormats?: string;
  budget: number;
  submissionDays: number;
  attachments?: { key: string; name: string }[];
  /** The client ticked "no refund because I didn't like any entry". */
  acceptNoRefund?: boolean;
}

export async function getContest(ctx: Ctx, id: number): Promise<Contest> {
  const c = await ctx.db.select().from(contests).where(eq(contests.id, id)).get();
  if (!c) throw notFound("Уралдаан олдсонгүй");
  return c;
}

async function validate(ctx: Ctx, input: Partial<ContestInput>, partial: boolean) {
  const s = await getSettings(ctx.db);
  if (!partial || input.title !== undefined) {
    if (!input.title || input.title.trim().length < 3 || input.title.length > 120) throw badRequest("title", "Гарчиг 3–120 тэмдэгт байна");
  }
  if (!partial || input.category !== undefined) {
    if (!CATEGORIES.includes(input.category as (typeof CATEGORIES)[number])) throw badRequest("category", "Ангилал буруу");
  }
  if (!partial || input.budget !== undefined) {
    if (!Number.isSafeInteger(input.budget) || input.budget! < s.min_budget) {
      throw badRequest("budget", `Хамгийн бага төсөв ${s.min_budget}₮`);
    }
  }
  if (!partial || input.submissionDays !== undefined) {
    const d = input.submissionDays!;
    if (!Number.isInteger(d) || d < s.submission_days_min || d > s.submission_days_max) {
      throw badRequest("submissionDays", `Хугацаа ${s.submission_days_min}–${s.submission_days_max} хоног`);
    }
  }
  return s;
}

export async function createDraft(ctx: Ctx, actor: Actor, input: ContestInput): Promise<Contest> {
  const s = await validate(ctx, input, false);
  const { feeAmount, prizeAmount } = calcFee(input.budget, s.fee_percent);
  const [c] = await ctx.db
    .insert(contests)
    .values({
      clientId: actor.id!,
      title: input.title.trim(),
      category: input.category,
      description: input.description ?? "",
      requirements: input.requirements ?? "",
      deliverableFormats: input.deliverableFormats ?? "",
      budget: input.budget,
      feePercent: s.fee_percent, // snapshot: later setting changes don't affect this contest
      feeAmount,
      prizeAmount,
      submissionDays: input.submissionDays,
      noRefundAcceptedAt: input.acceptNoRefund ? ctx.now() : null,
    })
    .returning();
  if (input.attachments?.length) await addAttachments(ctx, c!.id, input.attachments);
  await audit(ctx.db, actor, "contest.create", "contest", c!.id, undefined, { budget: c!.budget });
  return c!;
}

async function addAttachments(ctx: Ctx, contestId: number, list: { key: string; name: string }[]) {
  for (const a of list) {
    if (!a.key.startsWith(`attachments/`)) throw badRequest("attachment", "Хавсралтын түлхүүр буруу");
  }
  await ctx.db.insert(contestAttachments).values(list.map((a) => ({ contestId, fileUrl: a.key, fileName: a.name.slice(0, 200) })));
}

export async function updateDraft(ctx: Ctx, actor: Actor, id: number, input: Partial<ContestInput>): Promise<Contest> {
  const c = await getContest(ctx, id);
  if (c.clientId !== actor.id) throw forbidden();
  if (c.status !== "draft") throw badRequest("not_draft", "Зөвхөн ноорог үед засна");
  await validate(ctx, input, true);
  const budget = input.budget ?? c.budget;
  const { feeAmount, prizeAmount } = calcFee(budget, c.feePercent);
  const [u] = await ctx.db
    .update(contests)
    .set({
      title: input.title?.trim() ?? c.title,
      category: input.category ?? c.category,
      description: input.description ?? c.description,
      requirements: input.requirements ?? c.requirements,
      deliverableFormats: input.deliverableFormats ?? c.deliverableFormats,
      budget,
      feeAmount,
      prizeAmount,
      submissionDays: input.submissionDays ?? c.submissionDays,
      noRefundAcceptedAt: input.acceptNoRefund === undefined ? c.noRefundAcceptedAt : input.acceptNoRefund ? ctx.now() : null,
      updatedAt: ctx.now(),
    })
    .where(and(eq(contests.id, id), eq(contests.status, "draft")))
    .returning();
  if (!u) throw badRequest("not_draft", "Зөвхөн ноорог үед засна");
  if (input.attachments?.length) await addAttachments(ctx, id, input.attachments);
  return u;
}

/** draft -> awaiting_payment; generates the unique transfer reference (UB-XXXXX). */
export async function submitForPayment(ctx: Ctx, actor: Actor, id: number): Promise<Contest> {
  const c = await getContest(ctx, id);
  if (c.clientId !== actor.id) throw forbidden();
  if (!c.noRefundAcceptedAt) throw badRequest("rules", "Уралдааны дүрмийг (буцаалтгүй нөхцөл) зөвшөөрнө үү");
  const s = await getSettings(ctx.db);
  if (!s.system_account_number) throw badRequest("no_system_account", "Системийн данс тохируулаагүй байна. Админтай холбогдоно уу.");
  // Keep existing code if the client goes back and forth; retry on the (unlikely) unique collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = c.paymentRefCode ?? generateRefCode();
    try {
      const u = await transition(ctx.db, id, ["draft"], "awaiting_payment", { paymentRefCode: ref });
      await audit(ctx.db, actor, "contest.submit_for_payment", "contest", id, { status: "draft" }, { status: u.status, ref });
      return u;
    } catch (e) {
      if (isUniqueViolation(e) && !c.paymentRefCode) continue;
      throw e;
    }
  }
  throw new Error("could not allocate payment ref code");
}

export async function cancelDraft(ctx: Ctx, actor: Actor, id: number) {
  const c = await getContest(ctx, id);
  if (c.clientId !== actor.id) throw forbidden();
  const u = await transition(ctx.db, id, ["draft", "awaiting_payment"], "cancelled");
  await audit(ctx.db, actor, "contest.cancel", "contest", id, { status: c.status }, { status: u.status });
  return u;
}

/** Called when the payment is confirmed and the brief is approved (or auto-approved). */
export function publishFields(c: Pick<Contest, "submissionDays">, now: number) {
  return { publishedAt: now, submissionDeadline: now + c.submissionDays * DAY };
}

export async function countActiveEntries(ctx: Ctx, contestId: number): Promise<number> {
  const r = await ctx.db
    .select({ n: count() })
    .from(entries)
    .where(and(eq(entries.contestId, contestId), eq(entries.status, "active")))
    .get();
  return r?.n ?? 0;
}

export const PUBLIC_STATUSES = ["active", "extended", "selecting", "handover", "payout_pending", "completed"] as const;

export async function listPublic(
  ctx: Ctx,
  q: { category?: string; minBudget?: number; status?: string; page?: number },
) {
  const page = Math.max(1, q.page ?? 1);
  const statuses = q.status === "open" ? ["active", "extended"] : q.status === "closed" ? ["selecting", "handover", "payout_pending", "completed"] : [...PUBLIC_STATUSES];
  const where = [inArray(contests.status, statuses as Contest["status"][])];
  if (q.category) where.push(eq(contests.category, q.category));
  if (q.minBudget) where.push(gte(contests.budget, q.minBudget));
  const rows = await ctx.db
    .select({
      id: contests.id,
      title: contests.title,
      category: contests.category,
      budget: contests.budget,
      prizeAmount: contests.prizeAmount,
      status: contests.status,
      submissionDeadline: contests.submissionDeadline,
      publishedAt: contests.publishedAt,
      entryCount: sql<number>`(SELECT COUNT(*) FROM entries e WHERE e.contest_id = ${contests.id} AND e.status = 'active')`,
    })
    .from(contests)
    .where(and(...where))
    .orderBy(desc(contests.publishedAt))
    .limit(20)
    .offset((page - 1) * 20);
  return rows;
}
