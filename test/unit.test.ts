import { describe, expect, it } from "vitest";
import { calcFee, splitEvenly, formatMNT } from "../src/lib/money";
import { generateRefCode } from "../src/lib/refcode";
import { addBusinessDays } from "../src/lib/time";
import { canTransition } from "../src/services/contestState";
import { encryptField, decryptField } from "../src/lib/crypto";

describe("money", () => {
  it("500,000 -> 475,000 prize + 25,000 fee", () => {
    expect(calcFee(500000, "5.00")).toEqual({ feeAmount: 25000, prizeAmount: 475000 });
  });
  it("rounds fee half-up with integer math", () => {
    expect(calcFee(50010, "5.00")).toEqual({ feeAmount: 2501, prizeAmount: 47509 }); // 2500.5 -> 2501
    expect(calcFee(123457, "7.5")).toEqual({ feeAmount: 9259, prizeAmount: 114198 }); // 9259.275
  });
  it("split remainder goes to the first", () => {
    const parts = splitEvenly(475000, 3);
    expect(parts).toEqual([158334, 158333, 158333]);
    expect(parts.reduce((a, b) => a + b)).toBe(475000);
  });
  it("formats", () => expect(formatMNT(475000)).toBe("475,000₮"));
});

describe("ref code", () => {
  it("has no ambiguous characters", () => {
    for (let i = 0; i < 500; i++) {
      const c = generateRefCode();
      expect(c).toMatch(/^UB-[A-HJ-NP-Z2-9]{5}$/);
    }
  });
});

describe("business days", () => {
  it("skips the weekend (Fri -> Wed for 3 days)", () => {
    const fri = Date.UTC(2026, 10, 6, 2) / 1000; // Fri 10:00 UB
    const r = new Date((addBusinessDays(fri, 3) + 8 * 3600) * 1000);
    expect(r.getUTCDay()).toBe(3);
  });
});

describe("state machine", () => {
  it("allows only listed transitions", () => {
    expect(canTransition("draft", "awaiting_payment")).toBe(true);
    expect(canTransition("draft", "active")).toBe(false);
    expect(canTransition("completed", "refund_pending")).toBe(false);
    expect(canTransition("selecting", "payout_pending")).toBe(true);
  });
});

describe("bank account encryption", () => {
  it("round-trips", async () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
    const enc = await encryptField("1234567890", key);
    expect(enc).not.toContain("1234567890");
    expect(await decryptField(enc, key)).toBe("1234567890");
  });
});
