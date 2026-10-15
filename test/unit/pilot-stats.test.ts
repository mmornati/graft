import { describe, expect, it } from "vitest";
import { sizeBucket } from "../../src/core/size.js";
import { sizeStratum } from "../../src/eval/sample.js";
import { emptyCounts, metricsCountsSchema } from "../../src/modules/pilot/index.js";
import { percentile, summarize, wilson } from "../../src/pilot/stats.js";

describe("pilot statistics", () => {
  it("U-GATE-1 wilson: null for n = 0, pinned values, and the upper bound of n of n is 1", () => {
    expect(wilson(0, 0)).toBeNull();
    const a = wilson(9, 10);
    expect(a?.lower).toBeCloseTo(0.5958499704752279, 9);
    expect(a?.upper).toBeCloseTo(0.9821237871039259, 9);
    const b = wilson(118, 128);
    expect(b?.lower).toBeCloseTo(0.8621530676193262, 9);
    expect(b?.upper).toBeCloseTo(0.9570126251483656, 9);
    expect(wilson(10, 10)?.upper).toBe(1);
    expect(wilson(150, 150)?.upper).toBe(1);
    expect(wilson(0, 10)?.lower).toBe(0);
  });

  it("U-BASE-12 percentile is type 7 and summarize([]) is empty", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 0.5)).toBe(5.5);
    expect(percentile(xs, 0.9)).toBeCloseTo(9.1, 12);
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.9)).toBe(7);
    expect(summarize(xs)).toEqual({ n: 10, p50: 5.5, p75: 7.8, p90: 9.1 });
    expect(summarize([])).toEqual({ n: 0, p50: null, p75: null, p90: null });
    // The input is not mutated and need not be sorted.
    const unsorted = [3, 1, 2];
    expect(summarize(unsorted).p50).toBe(2);
    expect(unsorted).toEqual([3, 1, 2]);
  });

  it("U-BASE-14 sizeBucket boundaries 50/51, 300/301, 1500/1501 equal step 4's sizeStratum", () => {
    const cases: [number, string][] = [
      [0, "S"],
      [50, "S"],
      [51, "M"],
      [300, "M"],
      [301, "L"],
      [1500, "L"],
      [1501, "XL"],
    ];
    for (const [n, want] of cases) {
      expect(sizeBucket(n)).toBe(want);
      expect(sizeStratum(n)).toBe(want);
    }
  });

  it("U-ROLL-1 metricsCountsSchema rejects an unknown key and a negative count", () => {
    const ok = emptyCounts();
    expect(metricsCountsSchema.safeParse(ok).success).toBe(true);
    expect(metricsCountsSchema.safeParse({ ...ok, surprise: 1 }).success).toBe(false);
    expect(metricsCountsSchema.safeParse({ ...ok, prs_opened: -1 }).success).toBe(false);
    expect(metricsCountsSchema.safeParse({ ...ok, prs_opened: 1.5 }).success).toBe(false);
    expect(metricsCountsSchema.safeParse({ ...ok, cost_usd: "1.5e3" }).success).toBe(false);
    const { prs_opened: _omitted, ...missing } = ok;
    expect(metricsCountsSchema.safeParse(missing).success).toBe(false);
  });
});
