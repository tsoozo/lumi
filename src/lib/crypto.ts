const enc = new TextEncoder();

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomDigits(n: number): string {
  const b = new Uint32Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => String(x % 10)).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToB64(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b));
}

async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(keyB64);
  if (raw.length !== 32) throw new Error("BANK_ENCRYPTION_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM; output "v1:<iv b64>:<ciphertext b64>". */
export async function encryptField(plain: string, keyB64: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keyB64), enc.encode(plain));
  return `v1:${bytesToB64(iv)}:${bytesToB64(new Uint8Array(ct))}`;
}

export async function decryptField(blob: string, keyB64: string): Promise<string> {
  const [v, ivB64, ctB64] = blob.split(":");
  if (v !== "v1" || !ivB64 || !ctB64) throw new Error("bad ciphertext");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(ivB64) }, await aesKey(keyB64), b64ToBytes(ctB64));
  return new TextDecoder().decode(pt);
}
