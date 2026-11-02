import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { contestAttachments, contests, entries, handovers, notifications, payouts, users, type User } from "../db/schema";
import type { Env } from "../env";
import { AppError, badRequest, forbidden } from "../lib/errors";
import { allow } from "../lib/ratelimit";
import * as admin from "../services/admin";
import { audit } from "../services/audit";
import type { Actor, Ctx } from "../services/context";
import * as contestSvc from "../services/contests";
import * as entrySvc from "../services/entries";
import * as handoverSvc from "../services/handovers";
import * as paymentSvc from "../services/payments";
import * as payoutSvc from "../services/payouts";
import { DEFAULT_SETTINGS, getSettings, setSetting, type SettingKey } from "../services/settings";
import * as uploads from "../services/uploads";
import * as userSvc from "../services/users";

type Vars = { ctx: Ctx; user: User | null; actor: Actor | null };
export type AppEnv = { Bindings: Env; Variables: Vars };
type C = Context<AppEnv>;

const SESSION_COOKIE = "sid";
const id = (c: C, name = "id") => {
  const n = Number(c.req.param(name));
  if (!Number.isSafeInteger(n) || n <= 0) throw badRequest("id", "ID буруу");
  return n;
};
const ip = (c: C) => c.req.header("cf-connecting-ip") ?? null;
function need(c: C): Actor {
  const a = c.get("actor");
  if (!a) throw new AppError(401, "unauthorized", "Нэвтэрнэ үү");
  return a;
}
function needAdmin(c: C): Actor {
  const a = need(c);
  if (a.type !== "admin") throw forbidden();
  return a;
}
async function body<T = Record<string, unknown>>(c: C): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw badRequest("json", "JSON буруу");
  }
}

export function apiRoutes(makeCtx: (env: Env) => Ctx) {
  const api = new Hono<AppEnv>();

  api.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: err.code, message: err.message }, err.status);
    console.error(err);
    return c.json({ error: "internal", message: "Серверийн алдаа" }, 500);
  });

  api.use("*", async (c, next) => {
    const ctx = makeCtx(c.env);
    c.set("ctx", ctx);
    const user = await userSvc.userFromSession(ctx, getCookie(c, SESSION_COOKIE));
    c.set("user", user);
    c.set("actor", user ? userSvc.actorFor(user, ip(c)) : null);
    // CSRF: state-changing requests must be same-origin JSON (cookie is SameSite=Lax too).
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !c.req.path.startsWith("/api/telegram/")) {
      const origin = c.req.header("origin");
      if (origin && new URL(origin).host !== new URL(c.req.url).host) throw forbidden("Origin буруу");
    }
    await next();
  });

  // ------------------------------------------------------------------ auth (passwordless)
  api.post("/auth/request-code", async (c) => {
    if (!allow(`code:${ip(c)}`, 10, 3600)) throw new AppError(429, "rate_limited", "Хэт олон оролдлого");
    const b = await body<{ email: string }>(c);
    return c.json(await userSvc.requestCode(c.get("ctx"), b.email));
  });
  // Spec names: register/login. Both: email + code -> session (account is created on first login).
  const loginHandler = async (c: C) => {
    if (!allow(`login:${ip(c)}`, 20, 3600)) throw new AppError(429, "rate_limited", "Хэт олон оролдлого");
    const b = await body<{ email: string; code: string }>(c);
    const r = await userSvc.login(c.get("ctx"), b.email, b.code, ip(c));
    setCookie(c, SESSION_COOKIE, r.token, { httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Lax", path: "/", maxAge: r.maxAge });
    return c.json({ user: publicMe(r.user) });
  };
  api.post("/auth/login", loginHandler);
  api.post("/auth/register", loginHandler);
  api.post("/auth/logout", async (c) => {
    await userSvc.logout(c.get("ctx"), getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ me
  api.get("/me", async (c) => {
    const u = c.get("user");
    if (!u) return c.json({ user: null });
    const ctx = c.get("ctx");
    const unread = await ctx.db.select().from(notifications).where(and(eq(notifications.userId, u.id), isNull(notifications.readAt))).orderBy(desc(notifications.id)).limit(20);
    return c.json({ user: publicMe(u), bankAccounts: await userSvc.listBankAccounts(ctx, need(c)), notifications: unread });
  });
  api.patch("/me", async (c) => c.json({ user: publicMe(await userSvc.updateProfile(c.get("ctx"), need(c), await body(c))) }));
  api.post("/me/bank-accounts", async (c) => {
    const a = need(c);
    if (!allow(`bank:${a.id}`, 5, 3600)) throw new AppError(429, "rate_limited", "Хэт олон оролдлого");
    return c.json(await userSvc.addBankAccount(c.get("ctx"), a, await body(c)));
  });
  api.get("/me/earnings", async (c) => c.json(await userSvc.earnings(c.get("ctx"), need(c))));
  api.get("/me/contests", async (c) => {
    const a = need(c);
    const rows = await c.get("ctx").db.select().from(contests).where(eq(contests.clientId, a.id!)).orderBy(desc(contests.id));
    return c.json(rows);
  });
  api.get("/me/entries", async (c) => {
    const a = need(c);
    const ctx = c.get("ctx");
    const rows = await ctx.db
      .select({ entryId: entries.id, entryTitle: entries.title, entryStatus: entries.status, isWinner: entries.isWinner, contestId: contests.id, contestTitle: contests.title, contestStatus: contests.status, handoverId: handovers.id })
      .from(entries)
      .innerJoin(contests, eq(contests.id, entries.contestId))
      .leftJoin(handovers, and(eq(handovers.contestId, contests.id), eq(handovers.entryId, entries.id)))
      .where(eq(entries.creatorId, a.id!))
      .orderBy(desc(entries.id))
      .limit(100);
    return c.json(rows);
  });
  api.post("/me/notifications/read", async (c) => {
    const a = need(c);
    await c.get("ctx").db.update(notifications).set({ readAt: c.get("ctx").now() }).where(and(eq(notifications.userId, a.id!), isNull(notifications.readAt)));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ public config
  api.get("/config", async (c) => {
    const s = await getSettings(c.get("ctx").db);
    return c.json({
      categories: contestSvc.CATEGORIES,
      minBudget: s.min_budget,
      feePercent: s.fee_percent,
      submissionDaysMin: s.submission_days_min,
      submissionDaysMax: s.submission_days_max,
      maxEntriesPerCreator: s.max_entries_per_creator,
      maxFinalists: s.max_finalists,
      maxUploadMb: s.max_upload_mb,
    });
  });

  // ------------------------------------------------------------------ contests
  api.get("/contests", async (c) => {
    const q = c.req.query();
    return c.json(await contestSvc.listPublic(c.get("ctx"), { category: q.category, minBudget: q.minBudget ? Number(q.minBudget) : undefined, status: q.status, page: q.page ? Number(q.page) : 1 }));
  });
  api.post("/contests", async (c) => c.json(await contestSvc.createDraft(c.get("ctx"), need(c), await body(c))));
  api.get("/contests/:id", async (c) => {
    const ctx = c.get("ctx");
    const ct = await contestSvc.getContest(ctx, id(c));
    const actor = c.get("actor");
    const isClient = actor?.id === ct.clientId;
    const isAdmin = actor?.type === "admin";
    const isPublic = (contestSvc.PUBLIC_STATUSES as readonly string[]).includes(ct.status);
    if (!isPublic && !isClient && !isAdmin) throw forbidden("Энэ уралдаан нийтлэгдээгүй байна");
    const s = await getSettings(ctx.db);
    const attachments = await ctx.db.select().from(contestAttachments).where(eq(contestAttachments.contestId, ct.id));
    const entryCount = await contestSvc.countActiveEntries(ctx, ct.id);
    const h = await ctx.db.select({ id: handovers.id, entryId: handovers.entryId, status: handovers.status }).from(handovers).where(eq(handovers.contestId, ct.id)).get();
    const out: Record<string, unknown> = {
      ...ct,
      paymentRefCode: isClient || isAdmin ? ct.paymentRefCode : undefined,
      attachments: attachments.map((a) => ({ name: a.fileName, url: uploads.publicUrl(ctx, a.fileUrl) })),
      entryCount,
      isClient,
      minEntries: s.min_entries,
      handover: h ?? null,
    };
    if (isClient) {
      out.lowEntries = ct.status === "selecting" && entryCount < s.min_entries;
      out.canExtend = out.lowEntries && ct.extendedCount < 1;
      if (["awaiting_payment", "payment_review"].includes(ct.status)) {
        out.payment = {
          bankName: s.system_bank_name,
          accountNumber: s.system_account_number,
          accountHolder: s.system_account_holder,
          amountDue: await paymentSvc.amountDue(ctx, ct.id),
          refCode: ct.paymentRefCode,
          history: await paymentSvc.listContestPayments(ctx, ct.id),
        };
      }
    }
    if (actor?.id && h) {
      const e = await ctx.db.select({ creatorId: entries.creatorId }).from(entries).where(eq(entries.id, h.entryId)).get();
      out.isWinner = e?.creatorId === actor.id;
    }
    return c.json(out);
  });
  api.patch("/contests/:id", async (c) => c.json(await contestSvc.updateDraft(c.get("ctx"), need(c), id(c), await body(c))));
  api.post("/contests/:id/submit-for-payment", async (c) => c.json(await contestSvc.submitForPayment(c.get("ctx"), need(c), id(c))));
  api.post("/contests/:id/cancel", async (c) => c.json(await contestSvc.cancelDraft(c.get("ctx"), need(c), id(c))));
  api.post("/contests/:id/extend", async (c) => c.json(await entrySvc.extendContest(c.get("ctx"), need(c), id(c))));
  api.post("/contests/:id/refund-low-entries", async (c) => c.json(await entrySvc.refundLowEntries(c.get("ctx"), need(c), id(c))));
  api.post("/contests/:id/refund-partial", async (c) => c.json(await paymentSvc.refundPartialPayment(c.get("ctx"), need(c), id(c))));
  api.post("/contests/:id/finalists", async (c) => {
    const b = await body<{ entryIds: number[] }>(c);
    await entrySvc.setFinalists(c.get("ctx"), need(c), id(c), b.entryIds ?? []);
    return c.json({ ok: true });
  });
  api.post("/contests/:id/winner", async (c) => {
    const b = await body<{ entryId: number }>(c);
    return c.json(await entrySvc.selectWinner(c.get("ctx"), need(c), id(c), Number(b.entryId)));
  });

  // ------------------------------------------------------------------ payments (incoming)
  api.post("/contests/:id/payments", async (c) => {
    const a = need(c);
    if (!allow(`pay:${a.id}`, 10, 3600)) throw new AppError(429, "rate_limited", "Хэт олон оролдлого");
    return c.json(await paymentSvc.reportPayment(c.get("ctx"), a, id(c), await body(c)));
  });
  api.get("/contests/:id/payments", async (c) => {
    const ctx = c.get("ctx");
    const ct = await contestSvc.getContest(ctx, id(c));
    const a = need(c);
    if (a.id !== ct.clientId && a.type !== "admin") throw forbidden();
    return c.json(await paymentSvc.listContestPayments(ctx, ct.id));
  });

  // ------------------------------------------------------------------ entries
  api.get("/contests/:id/entries", async (c) => {
    const ctx = c.get("ctx");
    const rows = await entrySvc.listEntries(ctx, c.get("actor"), id(c));
    return c.json(rows.map((e) => ({ ...e, watermarkedUrl: uploads.publicUrl(ctx, e.watermarkedUrl), previewUrl: uploads.publicUrl(ctx, e.previewUrl) })));
  });
  api.post("/contests/:id/entries", async (c) => c.json(await entrySvc.createEntry(c.get("ctx"), need(c), id(c), await body(c))));
  api.patch("/entries/:id", async (c) => c.json(await entrySvc.updateEntry(c.get("ctx"), need(c), id(c), await body(c))));
  api.delete("/entries/:id", async (c) => c.json(await entrySvc.withdrawEntry(c.get("ctx"), need(c), id(c))));
  api.post("/entries/:id/rating", async (c) => {
    const b = await body<{ stars: number }>(c);
    await entrySvc.rateEntry(c.get("ctx"), need(c), id(c), Number(b.stars));
    return c.json({ ok: true });
  });
  api.get("/entries/:id/comments", async (c) => c.json(await entrySvc.listComments(c.get("ctx"), need(c), id(c))));
  api.post("/entries/:id/comments", async (c) => {
    const b = await body<{ body: string }>(c);
    return c.json(await entrySvc.addComment(c.get("ctx"), need(c), id(c), b.body));
  });

  // ------------------------------------------------------------------ handover
  api.get("/handovers/:id", async (c) => c.json(await handoverSvc.getHandoverForUser(c.get("ctx"), need(c), id(c))));
  api.post("/handovers/:id/files", async (c) => {
    const b = await body<{ keys: string[]; agreeIp: boolean }>(c);
    return c.json(await handoverSvc.sendFiles(c.get("ctx"), need(c), id(c), b.keys ?? [], !!b.agreeIp));
  });
  api.post("/handovers/:id/accept", async (c) => c.json(await handoverSvc.acceptHandover(c.get("ctx"), need(c), id(c))));
  api.post("/handovers/:id/agree-ip", async (c) => {
    await handoverSvc.agreeIp(c.get("ctx"), need(c), id(c));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ reports
  api.post("/reports", async (c) => c.json(await admin.createReport(c.get("ctx"), need(c), await body(c))));

  // ------------------------------------------------------------------ uploads
  api.post("/uploads/presign", async (c) => {
    const a = need(c);
    if (!allow(`upl:${a.id}`, 60, 3600)) throw new AppError(429, "rate_limited", "Хэт олон оролдлого");
    return c.json(await uploads.presignUpload(c.get("ctx"), a, await body(c)));
  });
  api.put("/uploads/direct/:purpose/:key{.+}", async (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const ab = await c.req.arrayBuffer();
    return c.json(await uploads.directUpload(c.get("ctx"), need(c), c.req.param("purpose"), key, ab, c.req.header("content-type") ?? "application/octet-stream"));
  });
  api.get("/files/:key{.+}", async (c) => {
    const r = await uploads.signedDownload(c.get("ctx"), need(c), c.req.param("key"));
    if ("url" in r && r.url) return c.json({ url: r.url });
    const obj = (r as { object: R2ObjectBody }).object;
    return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "content-disposition": "attachment", "cache-control": "private, no-store" } });
  });
  // Dev fallback for public files when no r2.dev / custom domain is configured.
  api.get("/public/:key{.+}", async (c) => {
    const obj = await c.env.PUBLIC_FILES.get(c.req.param("key"));
    if (!obj) return c.notFound();
    const type = obj.httpMetadata?.contentType ?? "application/octet-stream";
    return new Response(obj.body, {
      headers: {
        "content-type": type === "image/svg+xml" ? "application/octet-stream" : type,
        "cache-control": "public, max-age=86400",
        "x-content-type-options": "nosniff",
      },
    });
  });

  // ------------------------------------------------------------------ admin (web fallback; same services as Telegram)
  api.get("/admin/payments", async (c) => {
    needAdmin(c);
    const status = (c.req.query("status") ?? "reported") as "reported";
    return c.json(await paymentSvc.listPaymentsByStatus(c.get("ctx"), [status]));
  });
  api.post("/admin/payments/:id/confirm", async (c) => {
    const b = await body<{ bankTransactionRef?: string }>(c).catch(() => ({}) as { bankTransactionRef?: string });
    return c.json(await paymentSvc.confirmPayment(c.get("ctx"), needAdmin(c), id(c), b));
  });
  api.post("/admin/payments/:id/reject", async (c) => {
    const b = await body<{ reason: string; note?: string }>(c);
    return c.json(await paymentSvc.rejectPayment(c.get("ctx"), needAdmin(c), id(c), b.reason, b.note));
  });
  api.post("/admin/payments/:id/mismatch", async (c) => {
    const b = await body<{ receivedAmount: number }>(c);
    return c.json(await paymentSvc.markAmountMismatch(c.get("ctx"), needAdmin(c), id(c), Number(b.receivedAmount)));
  });
  api.get("/admin/payouts", async (c) => {
    const a = needAdmin(c);
    if (!["finance", "super"].includes(a.adminLevel!)) throw forbidden();
    const ctx = c.get("ctx");
    const status = (c.req.query("status") ?? "pending") as "pending";
    const rows = await ctx.db.select({ id: payouts.id }).from(payouts).where(eq(payouts.status, status)).orderBy(desc(payouts.id)).limit(100);
    const out = [];
    for (const r of rows) {
      const d = await payoutSvc.payoutDetails(ctx, r.id);
      out.push({ ...d.payout, contestTitle: d.contest.title, refCode: d.contest.paymentRefCode, recipient: d.recipient.fullName ?? d.recipient.email, account: d.account ? { bankName: d.account.bankName, holder: d.account.accountHolderName, number: d.accountNumber, verified: d.account.isVerified, lockedUntil: d.account.lockedUntil } : null });
    }
    return c.json(out);
  });
  api.post("/admin/payouts/:id/mark-sent", async (c) => c.json(await payoutSvc.markPayoutSent(c.get("ctx"), needAdmin(c), id(c), await body(c))));
  api.post("/admin/payouts/:id/problem", async (c) => {
    const b = await body<{ reason: string }>(c);
    return c.json(await payoutSvc.markPayoutProblem(c.get("ctx"), needAdmin(c), id(c), b.reason ?? ""));
  });
  api.get("/admin/contests", async (c) => {
    needAdmin(c);
    const status = c.req.query("status");
    const ctx = c.get("ctx");
    const rows = await ctx.db.select().from(contests).where(status ? eq(contests.status, status as "active") : undefined).orderBy(desc(contests.id)).limit(100);
    return c.json(rows);
  });
  api.post("/admin/contests/:id/approve", async (c) => c.json(await admin.approveContest(c.get("ctx"), needAdmin(c), id(c))));
  api.post("/admin/contests/:id/reject", async (c) => {
    const b = await body<{ reason: string }>(c);
    return c.json(await admin.rejectContest(c.get("ctx"), needAdmin(c), id(c), b.reason ?? ""));
  });
  api.post("/admin/contests/:id/cancel", async (c) => c.json(await admin.cancelContest(c.get("ctx"), needAdmin(c), id(c))));
  api.post("/admin/contests/:id/refund-removed", async (c) => c.json(await admin.refundAfterRemovals(c.get("ctx"), needAdmin(c), id(c))));
  api.post("/admin/entries/:id/remove", async (c) => {
    const b = await body<{ reason: string }>(c);
    return c.json(await entrySvc.removeEntry(c.get("ctx"), needAdmin(c), id(c), b.reason ?? ""));
  });
  api.post("/admin/reports/:id/resolve", async (c) => {
    const b = await body<{ status: "resolved" | "rejected"; resolution: string }>(c);
    return c.json(await admin.resolveReport(c.get("ctx"), needAdmin(c), id(c), b.status, b.resolution ?? ""));
  });
  api.get("/admin/audit-logs", async (c) => {
    needAdmin(c);
    const q = c.req.query();
    return c.json(await admin.listAuditLogs(c.get("ctx"), { entityType: q.entityType, entityId: q.entityId ? Number(q.entityId) : undefined, page: q.page ? Number(q.page) : 1 }));
  });
  api.get("/admin/today", async (c) => {
    needAdmin(c);
    return c.json(await admin.todayReport(c.get("ctx")));
  });
  api.get("/admin/settings", async (c) => {
    needAdmin(c);
    return c.json(await getSettings(c.get("ctx").db));
  });
  api.put("/admin/settings", async (c) => {
    const a = needAdmin(c);
    if (a.adminLevel !== "super") throw forbidden();
    const ctx = c.get("ctx");
    const b = await body<Record<string, unknown>>(c);
    const before = await getSettings(ctx.db);
    for (const [k, v] of Object.entries(b)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      const def = DEFAULT_SETTINGS[k as SettingKey];
      const val = typeof def === "number" ? Number(v) : typeof def === "boolean" ? Boolean(v) : String(v);
      if (typeof def === "number" && (!Number.isFinite(val as number) || (val as number) < 0)) throw badRequest(k, `${k} буруу`);
      await setSetting(ctx.db, k as SettingKey, val as never);
    }
    const after = await getSettings(ctx.db);
    await audit(ctx.db, a, "settings.update", "settings", null, before, after);
    return c.json(after);
  });
  api.post("/admin/invites", async (c) => {
    const b = await body<{ email: string; level: "reviewer" | "finance" | "super" }>(c);
    return c.json(await admin.createAdminInvite(c.get("ctx"), needAdmin(c), b.email, b.level));
  });
  api.get("/admin/users", async (c) => {
    needAdmin(c);
    const rows = await c.get("ctx").db.select().from(users).where(eq(users.role, "admin"));
    return c.json(rows.map(publicMe));
  });

  return api;
}

function publicMe(u: User) {
  return { id: u.id, email: u.email, fullName: u.fullName, displayName: u.displayName, phone: u.phone, role: u.role, adminLevel: u.adminLevel, telegramLinked: !!u.telegramChatId };
}

