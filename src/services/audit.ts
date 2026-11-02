import type { DB } from "../db/client";
import { auditLogs } from "../db/schema";
import type { Actor } from "./context";

export function auditInsert(
  db: DB,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: number | null,
  before?: unknown,
  after?: unknown,
) {
  return db.insert(auditLogs).values({
    actorId: actor.id,
    actorType: actor.type,
    action,
    entityType,
    entityId,
    before: before === undefined ? null : JSON.stringify(before),
    after: after === undefined ? null : JSON.stringify(after),
    ip: actor.ip ?? null,
  });
}

export async function audit(...args: Parameters<typeof auditInsert>) {
  await auditInsert(...args);
}
