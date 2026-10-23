import { describe, expect, it } from "vitest";
import { createFailureCounter, createTokenBucket } from "../../src/modules/mcp/rate-limit.js";

describe("MCP rate limits (Phase 1 step 6, D9 a and b)", () => {
  it("U-MCPRL-1 token bucket: 60 in a minute pass, the 61st is refused with a Retry-After; refills with the injected clock; buckets are per token", () => {
    let now = 1_000_000;
    const bucket = createTokenBucket({ perMinute: 60, now: () => now });
    for (let i = 0; i < 60; i++)
      expect(bucket.take("t1"), `request ${i + 1}`).toEqual({ ok: true });
    const refused = bucket.take("t1");
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.retryAfterSeconds).toBe(1);
    // Another token has its own bucket.
    expect(bucket.take("t2")).toEqual({ ok: true });
    // One token refills per second at 60 per minute.
    now += 1000;
    expect(bucket.take("t1")).toEqual({ ok: true });
    expect(bucket.take("t1").ok).toBe(false);
    // A full minute refills the whole bucket, never more than its size.
    now += 120_000;
    for (let i = 0; i < 60; i++) expect(bucket.take("t1").ok).toBe(true);
    expect(bucket.take("t1").ok).toBe(false);
  });

  it("U-MCPRL-2 failed-auth counter per IP: the limit refuses for the rest of the window; a success does not reset it; other IPs are unaffected", () => {
    let now = 5_000_000;
    const counter = createFailureCounter({ perMinute: 20, now: () => now });
    for (let i = 0; i < 20; i++) {
      expect(counter.check("10.0.0.1").ok).toBe(true);
      counter.fail("10.0.0.1");
    }
    const blocked = counter.check("10.0.0.1");
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.retryAfterSeconds).toBe(60);
    // A success is not a reset: there is no such call, and the IP stays blocked.
    now += 30_000;
    const later = counter.check("10.0.0.1");
    expect(later.ok === false && later.retryAfterSeconds).toBe(30);
    expect(counter.check("10.0.0.2")).toEqual({ ok: true });
    // The next window starts clean.
    now += 30_000;
    expect(counter.check("10.0.0.1")).toEqual({ ok: true });
  });
});
