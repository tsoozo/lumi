import type { Env } from "../env";
import type { Mailer } from "../services/context";

/** Resend (free tier) via fetch. Without an API key, emails are logged (local dev shows login codes in the console). */
export function makeMailer(env: Env): Mailer {
  return {
    async send(to, subject, text) {
      if (!env.RESEND_API_KEY) {
        console.log(`[email disabled] to=${to} subject=${subject}\n${text}`);
        return;
      }
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }),
      });
      if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
    },
  };
}
