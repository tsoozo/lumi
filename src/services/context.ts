import type { DB } from "../db/client";
import type { Env } from "../env";
import type { Contest, Payment, Payout } from "../db/schema";

/** Outbound Telegram (admin bot). Kept as an interface so services are testable and bot-free. */
export interface AdminChannel {
  paymentReported(p: Payment, c: Contest): Promise<void>;
  paymentResolved(p: Payment, c: Contest, text: string): Promise<void>;
  payoutReady(p: Payout, c: Contest): Promise<void>;
  payoutResolved(p: Payout, c: Contest, text: string): Promise<void>;
  /** Free text to admins with given levels (reminders, daily report). */
  broadcast(text: string, levels?: ("reviewer" | "finance" | "super")[]): Promise<void>;
}

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export interface Actor {
  type: "user" | "admin" | "system" | "telegram";
  id: number | null;
  ip?: string | null;
  adminLevel?: "reviewer" | "finance" | "super" | null;
}

export interface Ctx {
  db: DB;
  env: Env;
  now: () => number;
  admin: AdminChannel;
  mailer: Mailer;
}

export const SYSTEM: Actor = { type: "system", id: null };

export function requireAdminLevel(actor: Actor, allowed: ("reviewer" | "finance" | "super")[]) {
  if (actor.type !== "admin" && actor.type !== "telegram") throw new AdminError();
  if (!actor.adminLevel) throw new AdminError();
  if (actor.adminLevel === "super") return; // super admin can do everything
  if (!allowed.includes(actor.adminLevel)) throw new AdminError();
}

import { AppError } from "../lib/errors";
class AdminError extends AppError {
  constructor() {
    super(403, "forbidden", "Энэ үйлдлийг хийх админы эрх хүрэхгүй байна");
  }
}
