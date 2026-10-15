import { describe, expect, it } from "vitest";
import { scaled, TIMEOUTS, WaitTimeout, waitUntil } from "../../src/e2e/waiters.js";

/** A virtual clock: sleeping advances time; no real timer is used. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    async sleep(ms: number) {
      sleeps.push(ms);
      t += ms;
    },
  };
}

const httpError = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error("http"), { status, response: { headers } });

describe("waiters", () => {
  it("U-LIVE-WAIT-1 backs off 2, 3, 4.5, 6.75, 10.125, 15, 15 s; returns the first truthy value; times out with the last observation", async () => {
    const clock = fakeClock();
    let n = 0;
    const value = await waitUntil(
      async () => (++n === 8 ? { done: n } : false),
      { name: "x", timeoutMs: 10 * 60_000 },
      clock,
    );
    expect(value).toEqual({ done: 8 });
    expect(clock.sleeps).toEqual([2000, 3000, 4500, 6750, 10125, 15000, 15000]);

    const clock2 = fakeClock();
    let calls = 0;
    const err = await waitUntil(
      async () => {
        calls += 1;
        return false as const;
      },
      { name: "never", timeoutMs: 10_000 },
      clock2,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaitTimeout);
    expect((err as WaitTimeout).waitName).toBe("never");
    expect((err as WaitTimeout).lastObservation).toBe(false);
    // 2 + 3 + 4.5 = 9.5 s, then the last sleep is cut to the 0.5 s that remain.
    expect(clock2.sleeps).toEqual([2000, 3000, 4500, 500]);
    expect(calls).toBe(5);
  });

  it("U-LIVE-WAIT-1 --timeout-scale multiplies every timeout", () => {
    expect(scaled(TIMEOUTS.cardLive, 2)).toBe(1_200_000);
    expect(scaled(TIMEOUTS.delivery, 0.5)).toBe(45_000);
    expect(TIMEOUTS.cardLive).toBe(600_000);
    expect(TIMEOUTS.cardNone).toBe(120_000);
    expect(TIMEOUTS.delivery).toBe(90_000);
    expect(TIMEOUTS.stability).toBe(60_000);
  });

  it("U-LIVE-WAIT-2 transient and rate-limited errors are retried; a 404 or a programmer error propagates at once", async () => {
    const clock = fakeClock();
    let n = 0;
    const ok = await waitUntil(
      async () => {
        n += 1;
        if (n === 1) throw httpError(502);
        if (n === 2) throw httpError(403, { "x-ratelimit-remaining": "0" });
        if (n === 3) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        return "ready";
      },
      { name: "retry", timeoutMs: 60_000 },
      clock,
    );
    expect(ok).toBe("ready");
    expect(n).toBe(4);

    for (const e of [httpError(404), httpError(422), new TypeError("bug"), httpError(403)]) {
      const c = fakeClock();
      let calls = 0;
      const got = await waitUntil(
        async () => {
          calls += 1;
          throw e;
        },
        { name: "propagate", timeoutMs: 60_000 },
        c,
      ).catch((x: unknown) => x);
      expect(got).toBe(e);
      expect(calls).toBe(1);
      expect(c.sleeps).toEqual([]);
    }
  });
});
