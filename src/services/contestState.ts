import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { contests, type Contest, type ContestStatus } from "../db/schema";
import { conflict } from "../lib/errors";

/**
 * The only allowed status transitions. The server refuses everything else.
 *
 * draft ─► awaiting_payment ─► payment_review ─► pending_approval ─► active ─► selecting ─► handover ─► payout_pending ─► completed
 *                 ▲                  │                 │                         ▲   │  │                ▲
 *                 └──(rejected)──────┘                 └► refund_pending ◄───────┼───┘  └─(split)────────┘
 *                                                            │                   │
 *                                                            ▼            extended (+7d, once, <3 entries)
 *                                                         refunded
 */
export const TRANSITIONS: Record<ContestStatus, ContestStatus[]> = {
  draft: ["awaiting_payment", "cancelled"],
  awaiting_payment: ["payment_review", "draft", "cancelled", "refund_pending"], // refund_pending: partial (mismatched) payment returned
  payment_review: ["pending_approval", "active", "awaiting_payment"],
  pending_approval: ["active", "refund_pending"],
  active: ["selecting", "disputed"],
  extended: ["selecting", "disputed"],
  selecting: ["extended", "handover", "payout_pending", "refund_pending", "disputed"],
  handover: ["payout_pending", "disputed"],
  payout_pending: ["completed"],
  completed: [],
  refund_pending: ["refunded"],
  refunded: [],
  cancelled: [],
  disputed: ["selecting", "payout_pending", "refund_pending"],
};

export function canTransition(from: ContestStatus, to: ContestStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses in which creators may submit / edit / withdraw entries. */
export const ACCEPTING_ENTRIES: ContestStatus[] = ["active", "extended"];

/**
 * Builds a guarded UPDATE (… WHERE id=? AND status IN (from)) so that concurrent requests / cron runs
 * can't apply the same transition twice. Use `.returning()` and check the row count, or put it in a batch.
 */
export function transitionQuery(
  db: DB,
  contestId: number,
  from: ContestStatus[],
  to: ContestStatus,
  extra: Partial<typeof contests.$inferInsert> = {},
) {
  for (const f of from) {
    if (!canTransition(f, to)) throw new Error(`illegal contest transition ${f} -> ${to}`);
  }
  return db
    .update(contests)
    .set({ updatedAt: sql`(unixepoch())`, ...extra, status: to })
    .where(and(eq(contests.id, contestId), inArray(contests.status, from)))
    .returning();
}

/** Executes the guarded transition; throws 409 if the contest was not in an allowed `from` state. */
export async function transition(
  db: DB,
  contestId: number,
  from: ContestStatus[],
  to: ContestStatus,
  extra: Partial<typeof contests.$inferInsert> = {},
): Promise<Contest> {
  const rows = await transitionQuery(db, contestId, from, to, extra);
  if (rows.length === 0) throw conflict("invalid_state", "Уралдааны төлөв өөрчлөгдсөн байна. Хуудсаа шинэчилнэ үү.");
  return rows[0]!;
}
