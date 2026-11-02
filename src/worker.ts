import { Hono } from "hono";
import { webhookCallback } from "grammy";
import { makeDb } from "./db/client";
import type { Env } from "./env";
import { timingSafeEqual } from "./lib/crypto";
import { makeMailer } from "./lib/mailer";
import { createBot } from "./bot/bot";
import { telegramAdminChannel } from "./bot/messages";
import { apiRoutes, type AppEnv } from "./routes/api";
import type { Ctx } from "./services/context";
import { runCron } from "./services/lifecycle";
import { nowSec } from "./lib/time";

export function makeCtx(env: Env): Ctx {
  const ctx: Ctx = {
    db: makeDb(env.DB),
    env,
    now: nowSec,
    mailer: makeMailer(env),
    admin: undefined as unknown as Ctx["admin"],
  };
  ctx.admin = telegramAdminChannel(env, () => ctx);
  return ctx;
}

const app = new Hono<AppEnv>();

// Telegram webhook: secret in the URL path + X-Telegram-Bot-Api-Secret-Token header.
app.post("/api/telegram/webhook/:secret", async (c) => {
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !c.env.TELEGRAM_BOT_TOKEN || !timingSafeEqual(c.req.param("secret"), secret)) return c.text("not found", 404);
  const bot = await createBot(makeCtx(c.env));
  return webhookCallback(bot, "hono", { secretToken: secret })(c);
});

app.route("/api", apiRoutes(makeCtx));
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ectx: ExecutionContext) {
    ectx.waitUntil(runCron(makeCtx(env)));
  },
} satisfies ExportedHandler<Env>;
