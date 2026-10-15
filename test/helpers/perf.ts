import { expect } from "vitest";

/**
 * Wall-clock assertions are opt-in (`pnpm test:perf`, GRAFT_PERF=1): a loaded laptop or a small CI
 * runner must not fail the suite. The default suite asserts deterministic work units instead
 * (`GlobBudget` fuel, `exhausted`, `limitHits`, `pairsUsed`) and only a generous sanity ceiling here.
 */
export const PERF = process.env.GRAFT_PERF === "1";
export const SANITY_CEILING_MS = 30_000;

export function expectDuration(tookMs: number, limitMs: number, label?: string): void {
  expect(tookMs, label).toBeLessThan(PERF ? limitMs : SANITY_CEILING_MS);
}
