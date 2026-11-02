import { and, count, desc, eq, gte, isNull, sql, sum } from "drizzle-orm";
import { authCodes, bankAccounts, contests, payouts, sessions, users, type User } from "../db/schema";
import { encryptField, randomDigits, randomToken, sha256Hex, timingSafeEqual } from "../lib/crypto";
import { AppError, badRequest } from "../lib/errors";
import { DAY } from "../lib/time";
import { audit } from "./audit";
import type { Actor, Ctx } from "./context";
import { onBankAccountChanged } from "./payouts";

const CODE_TTL = 10 * 60; // login code valid for 10 minutes
const SESSION_TTL = 30 * DAY;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;

const normEmail = (e: string) => e.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Passwordless login: email one-time code (no heavy hashing -> fits the 10 ms CPU budget). */
export async function requestCode(ctx: Ctx, emailRaw: string) {
  const email = normEmail(emailRaw);
  if (!EMAIL_RE.test(email)) throw badRequest("email", "Имэйл буруу");
  const recent = await ctx.db
    .select({ n: count() })
    .from(authCodes)
    .where(and(eq(authCodes.email, email), gte(authCodes.createdAt, ctx.now() - 3600)))
    .get();
  if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR) throw new AppError(429, "rate_limited", "Хэт олон оролдлого. Түр хүлээнэ үү.");
  const code = randomDigits(6);
  await ctx.db.insert(authCodes).values({ email, codeHash: await sha256Hex(`${email}:${code}:${ctx.env.SESSION_SECRET}`), expiresAt: ctx.now() + CODE_TTL });
  await ctx.mailer.send(email, "Нэвтрэх код", `Таны нэвтрэх код: ${code}\n10 минут хүчинтэй.`);
  return { sent: true };
}

/** Verifies a code; used for login and for sensitive actions (bank account change). */
export async function verifyCode(ctx: Ctx, emailRaw: string, code: string): Promise<boolean> {
  const email = normEmail(emailRaw);
  const row = await ctx.db
    .select()
    .from(authCodes)
    .where(and(eq(authCodes.email, email), isNull(authCodes.usedAt), gte(authCodes.expiresAt, ctx.now())))
    .orderBy(desc(authCodes.id))
    .get();
  if (!row || row.attempts >= MAX_ATTEMPTS) return false;
  const hash = await sha256Hex(`${email}:${String(code).trim()}:${ctx.env.SESSION_SECRET}`);
  if (!timingSafeEqual(hash, row.codeHash)) {
    await ctx.db.update(authCodes).set({ attempts: row.attempts + 1 }).where(eq(authCodes.id, row.id));
    return false;
  }
  const used = await ctx.db.update(authCodes).set({ usedAt: ctx.now() }).where(and(eq(authCodes.id, row.id), isNull(authCodes.usedAt))).returning({ id: authCodes.id });
  return used.length === 1;
}

export async function login(ctx: Ctx, emailRaw: string, code: string, ip?: string | null) {
  const email = normEmail(emailRaw);
  if (!(await verifyCode(ctx, email, code))) throw badRequest("bad_code", "Код буруу эсвэл хугацаа дууссан");
  let u = await ctx.db.select().from(users).where(eq(users.email, email)).get();
  if (!u) {
    const isBootstrap = ctx.env.BOOTSTRAP_ADMIN_EMAIL && normEmail(ctx.env.BOOTSTRAP_ADMIN_EMAIL) === email;
    [u] = await ctx.db
      .insert(users)
      .values({ email, displayName: email.split("@")[0], ...(isBootstrap ? { role: "admin", adminLevel: "super" } : {}) })
      .returning();
    await audit(ctx.db, { type: "user", id: u!.id, ip }, "user.register", "user", u!.id);
  }
  if (u!.isBanned) throw new AppError(403, "banned", "Бүртгэл хаагдсан байна");
  const token = randomToken();
  await ctx.db.insert(sessions).values({ tokenHash: await sha256Hex(token), userId: u!.id, expiresAt: ctx.now() + SESSION_TTL });
  return { token, user: u!, maxAge: SESSION_TTL };
}

export async function userFromSession(ctx: Ctx, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const s = await ctx.db.select().from(sessions).where(eq(sessions.tokenHash, await sha256Hex(token))).get();
  if (!s || s.expiresAt < ctx.now()) return null;
  const u = await ctx.db.select().from(users).where(eq(users.id, s.userId)).get();
  if (!u || u.isBanned) return null;
  return u;
}

export async function logout(ctx: Ctx, token: string | undefined) {
  if (token) await ctx.db.delete(sessions).where(eq(sessions.tokenHash, await sha256Hex(token)));
}

export function actorFor(u: User, ip?: string | null): Actor {
  return u.role === "admin" && u.adminLevel
    ? { type: "admin", id: u.id, ip, adminLevel: u.adminLevel as Actor["adminLevel"] }
    : { type: "user", id: u.id, ip };
}

export async function updateProfile(ctx: Ctx, actor: Actor, input: { fullName?: string; displayName?: string; phone?: string }) {
  const [u] = await ctx.db
    .update(users)
    .set({
      ...(input.fullName !== undefined ? { fullName: input.fullName.trim().slice(0, 100) } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName.trim().slice(0, 50) } : {}),
      ...(input.phone !== undefined ? { phone: input.phone.trim().slice(0, 20) } : {}),
    })
    .where(eq(users.id, actor.id!))
    .returning();
  return u!;
}

const normName = (s: string) => s.toLowerCase().replace(/[^\p{L}]/gu, "");

/**
 * Register / change bank account. Requires a fresh email code (protects against a hijacked session
 * redirecting prize money). If a payout is pending, the new account is locked for 48h.
 */
export async function addBankAccount(
  ctx: Ctx,
  actor: Actor,
  input: { bankName: string; accountNumber: string; accountHolderName: string; code: string },
) {
  const u = await ctx.db.select().from(users).where(eq(users.id, actor.id!)).get();
  if (!u) throw badRequest("user", "Хэрэглэгч олдсонгүй");
  if (!(await verifyCode(ctx, u.email, input.code))) throw badRequest("bad_code", "Баталгаажуулах код буруу");
  const acc = input.accountNumber.replace(/\s/g, "");
  if (!/^\d{6,20}$/.test(acc)) throw badRequest("account", "Дансны дугаар буруу");
  if (!input.bankName?.trim() || !input.accountHolderName?.trim()) throw badRequest("bank", "Банк, эзэмшигчийн нэрээ оруулна уу");
  // Holder name must match the profile name; mismatches are allowed but flagged (is_verified=false) for the admin.
  const matches = !!u.fullName && (normName(u.fullName).includes(normName(input.accountHolderName)) || normName(input.accountHolderName).includes(normName(u.fullName)));
  await ctx.db.update(bankAccounts).set({ isActive: false }).where(eq(bankAccounts.userId, u.id));
  const [a] = await ctx.db
    .insert(bankAccounts)
    .values({
      userId: u.id,
      bankName: input.bankName.trim().slice(0, 50),
      accountNumberEncrypted: await encryptField(acc, ctx.env.BANK_ENCRYPTION_KEY),
      accountNumberLast4: acc.slice(-4),
      accountHolderName: input.accountHolderName.trim().slice(0, 100),
      isVerified: matches,
    })
    .returning();
  await audit(ctx.db, actor, "bank_account.add", "bank_account", a!.id, undefined, { bank: a!.bankName, last4: a!.accountNumberLast4, nameMatches: matches });
  await onBankAccountChanged(ctx, u.id, a!.id);
  const fresh = await ctx.db.select().from(bankAccounts).where(eq(bankAccounts.id, a!.id)).get();
  return publicAccount(fresh!);
}

export function publicAccount(a: typeof bankAccounts.$inferSelect) {
  return {
    id: a.id,
    bankName: a.bankName,
    accountNumberMasked: `••••${a.accountNumberLast4}`,
    accountHolderName: a.accountHolderName,
    isVerified: a.isVerified,
    isActive: a.isActive,
    lockedUntil: a.lockedUntil,
  };
}

export async function listBankAccounts(ctx: Ctx, actor: Actor) {
  const rows = await ctx.db.select().from(bankAccounts).where(eq(bankAccounts.userId, actor.id!)).orderBy(desc(bankAccounts.id));
  return rows.map(publicAccount);
}

export async function earnings(ctx: Ctx, actor: Actor) {
  const rows = await ctx.db
    .select({ payout: payouts, title: contests.title })
    .from(payouts)
    .innerJoin(contests, eq(contests.id, payouts.contestId))
    .where(eq(payouts.recipientId, actor.id!))
    .orderBy(desc(payouts.id));
  const total = rows.filter((r) => r.payout.status === "sent" && r.payout.type !== "refund").reduce((s, r) => s + r.payout.amount, 0);
  return { total, items: rows.map((r) => ({ ...r.payout, bankTransactionRef: r.payout.bankTransactionRef, contestTitle: r.title })) };
}

