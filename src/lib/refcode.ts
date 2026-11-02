// Unambiguous alphabet: no O/0, I/1 (also no L to avoid l/1 confusion in some fonts? spec only says O/0, I/1).
export const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRefCode(prefix = "UB", length = 5): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let s = "";
  // 256 % 32 === 0 so modulo is unbiased
  for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length];
  return `${prefix}-${s}`;
}
