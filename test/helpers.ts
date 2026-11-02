import { readFileSync, readdirSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import { makeDb } from "../src/db/client";
import { users } from "../src/db/schema";
import type { Env } from "../src/env";
import type { Actor, AdminChannel, Ctx } from "../src/services/context";
import { setSetting } from "../src/services/settings";

export async function setup() {
  const proxy = await getPlatformProxy<Env>({ persist: false, configPath: "wrangler.toml" });
  const env = proxy.env;
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(`migrations/${f}`, "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) await env.DB.prepare(stmt).run();
    }
  }
  return { env, dispose: proxy.dispose };
}

export function fakeAdmin() {
  const calls: { kind: string; id?: number; text?: string }[] = [];
  const admin: AdminChannel = {
    paymentReported: async (p) => void calls.push({ kind: "paymentReported", id: p.id }),
    paymentResolved: async (p, _c, text) => void calls.push({ kind: "paymentResolved", id: p.id, text }),
    payoutReady: async (p) => void calls.push({ kind: "payoutReady", id: p.id }),
    payoutResolved: async (p, _c, text) => void calls.push({ kind: "payoutResolved", id: p.id, text }),
    broadcast: async (text) => void calls.push({ kind: "broadcast", text }),
  };
  return { admin, calls };
}

export function makeTestCtx(rawEnv: Env) {
  const env = { ...rawEnv, SESSION_SECRET: "test", BANK_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))), APP_URL: "http://test" } as Env;
  let t = Math.floor(Date.UTC(2026, 10, 3, 2, 0, 0) / 1000); // Tue 10:00 UB
  const mails: { to: string; subject: string; text: string }[] = [];
  const { admin, calls } = fakeAdmin();
  const ctx: Ctx = { db: makeDb(env.DB), env, now: () => t, admin, mailer: { send: async (to, subject, text) => void mails.push({ to, subject, text }) } };
  return { ctx, calls, mails, advance: (sec: number) => (t += sec), now: () => t };
}

export async function seed(ctx: Ctx) {
  await setSetting(ctx.db, "system_account_number", "5000123456");
  await setSetting(ctx.db, "system_bank_name", "Хаан банк");
  await setSetting(ctx.db, "system_account_holder", "Lumi ХХК");
  const mk = async (email: string, extra: Partial<typeof users.$inferInsert> = {}) =>
    (await ctx.db.insert(users).values({ email, displayName: email.split("@")[0], ...extra }).returning())[0]!;
  const client = await mk("bold@x.mn", { fullName: "Бат Болд" });
  const c1 = await mk("saraa@x.mn", { fullName: "Дорж Сараа" });
  const c2 = await mk("tuya@x.mn", { fullName: "Туяа" });
  const c3 = await mk("anu@x.mn", { fullName: "Ану" });
  const reviewer = await mk("rev@x.mn", { role: "admin", adminLevel: "reviewer" });
  const finance = await mk("fin@x.mn", { role: "admin", adminLevel: "finance" });
  const u = (x: { id: number }): Actor => ({ type: "user", id: x.id });
  return {
    client, c1, c2, c3, reviewer, finance,
    A: {
      client: u(client), c1: u(c1), c2: u(c2), c3: u(c3),
      reviewer: { type: "admin", id: reviewer.id, adminLevel: "reviewer" } as Actor,
      finance: { type: "admin", id: finance.id, adminLevel: "finance" } as Actor,
    },
  };
}
