import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { settings } from "../db/schema";

/** Admin-editable settings. Defaults = values proposed in the spec. */
export const DEFAULT_SETTINGS = {
  fee_percent: "5.00",
  min_budget: 50000,
  submission_days_min: 3,
  submission_days_max: 14,
  selection_days: 7,
  selection_grace_days: 7,
  selection_reminders: 2,
  extend_days: 7,
  min_entries: 3,
  max_entries_per_creator: 3,
  max_finalists: 3,
  handover_files_days: 3,
  handover_accept_days: 3,
  payout_business_days: 3,
  payment_reminder_hours: 2,
  auto_approve_contests: true,
  bank_lock_hours: 48,
  max_upload_mb: 25,
  // System bank account shown to clients (prefer a company account).
  system_bank_name: "",
  system_account_number: "",
  system_account_holder: "",
};
export type Settings = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof Settings;

export async function getSettings(db: DB): Promise<Settings> {
  const rows = await db.select().from(settings);
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (!(r.key in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[r.key as SettingKey];
    out[r.key] = typeof def === "number" ? Number(r.value) : typeof def === "boolean" ? r.value === "true" : r.value;
  }
  return out as Settings;
}

export async function setSetting<K extends SettingKey>(db: DB, key: K, value: Settings[K]) {
  if (key === "fee_percent" && !/^\d{1,2}(\.\d{1,2})?$/.test(String(value))) throw new Error("bad fee_percent");
  await db
    .insert(settings)
    .values({ key, value: String(value) })
    .onConflictDoUpdate({ target: settings.key, set: { value: String(value), updatedAt: Math.floor(Date.now() / 1000) } });
}

export async function getSetting(db: DB, key: string): Promise<string | undefined> {
  const r = await db.select().from(settings).where(eq(settings.key, key)).get();
  return r?.value;
}
