/**
 * Tiny per-isolate rate limiter (best effort; isolates are not shared). Login codes are additionally
 * limited per email in the DB. For stronger limits, add a Cloudflare WAF rate limiting rule on /api/auth/*.
 */
const hits = new Map<string, { n: number; reset: number }>();
export function allow(key: string, max: number, windowSec: number): boolean {
  const now = Date.now() / 1000;
  const h = hits.get(key);
  if (!h || h.reset < now) {
    hits.set(key, { n: 1, reset: now + windowSec });
    if (hits.size > 5000) hits.clear();
    return true;
  }
  h.n++;
  return h.n <= max;
}
