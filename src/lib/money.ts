/** All money is integer ₮. fee_percent is kept as an exact decimal string like "5.00". */

/** Parse "5.00" -> 500 (hundredths of a percent) without floats. */
export function percentToBasisHundredths(p: string): number {
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(p.trim());
  if (!m) throw new Error(`invalid fee percent: ${p}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** fee = round(budget * fee_percent / 100), prize = budget - fee. Integer math only (round half up). */
export function calcFee(budget: number, feePercent: string): { feeAmount: number; prizeAmount: number } {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("budget must be a non-negative integer");
  const bh = percentToBasisHundredths(feePercent); // percent * 100
  // budget * (bh/100) / 100 = budget * bh / 10000
  const feeAmount = Math.floor((budget * bh + 5000) / 10000);
  return { feeAmount, prizeAmount: budget - feeAmount };
}

/** Equal split; the remainder ₮ goes to the first recipient so the sum matches exactly. */
export function splitEvenly(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const rest = total - base * n;
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + rest : base));
}

export function formatMNT(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "₮";
}
