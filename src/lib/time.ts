export const DAY = 86400;
export const HOUR = 3600;
export const nowSec = () => Math.floor(Date.now() / 1000);

/** Ulaanbaatar is UTC+8, no DST. */
const UB_OFFSET = 8 * HOUR;

/** Adds N business days (Mon–Fri, UB time). Public holidays are not modelled (TODO: settings list). */
export function addBusinessDays(fromSec: number, days: number): number {
  let t = fromSec;
  let added = 0;
  while (added < days) {
    t += DAY;
    const dow = new Date((t + UB_OFFSET) * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return t;
}

export function ubDateTime(sec: number): string {
  const d = new Date((sec + UB_OFFSET) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function ubHourMinute(sec: number): { hour: number; minute: number } {
  const d = new Date((sec + UB_OFFSET) * 1000);
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** Start of the current UB day, as unix seconds. */
export function ubStartOfDay(sec: number): number {
  return Math.floor((sec + UB_OFFSET) / DAY) * DAY - UB_OFFSET;
}
