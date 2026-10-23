/**
 * D9 (a) and (b): two in-memory buckets, per process. With N server processes the real limits are
 * N times higher (`docs/features/mcp.md` says so). The open cap (D9 c) is counted in the database.
 */

export type RateVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

const MINUTE_MS = 60_000;
/** Entries kept per bucket map before the oldest are dropped (bounds memory under a flood). */
const MAX_KEYS = 10_000;

function bounded<K, V>(map: Map<K, V>): void {
  while (map.size > MAX_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

/**
 * (a) A token bucket per token id: `perMinute` requests, refilled continuously at `perMinute` per
 * minute. Over the limit, the answer says how long until the next request may pass.
 */
export function createTokenBucket(o: { perMinute: number; now: () => number }) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const rate = o.perMinute / MINUTE_MS;
  return {
    take(key: string): RateVerdict {
      const now = o.now();
      const b = buckets.get(key) ?? { tokens: o.perMinute, at: now };
      const tokens = Math.min(o.perMinute, b.tokens + Math.max(0, now - b.at) * rate);
      buckets.delete(key);
      if (tokens < 1) {
        buckets.set(key, { tokens, at: now });
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / rate / 1000)) };
      }
      buckets.set(key, { tokens: tokens - 1, at: now });
      bounded(buckets);
      return { ok: true };
    },
  };
}

/**
 * (b) Failed authentications per client IP, in fixed one-minute windows. Once an IP reaches the
 * limit it is refused for the rest of its window, before any database lookup. A success does not
 * reset the count.
 */
export function createFailureCounter(o: { perMinute: number; now: () => number }) {
  const windows = new Map<string, { start: number; failures: number }>();
  const current = (ip: string) => {
    const now = o.now();
    const w = windows.get(ip);
    return w && now - w.start < MINUTE_MS ? w : { start: now, failures: 0 };
  };
  return {
    /** Before the lookup: whether this IP may try at all. */
    check(ip: string): RateVerdict {
      const w = current(ip);
      if (w.failures < o.perMinute) return { ok: true };
      const left = MINUTE_MS - (o.now() - w.start);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(left / 1000)) };
    },
    fail(ip: string): void {
      const w = current(ip);
      windows.delete(ip);
      windows.set(ip, { start: w.start, failures: w.failures + 1 });
      bounded(windows);
    },
  };
}
