/**
 * Cost bound (D15): the upper bound per expected model run is
 * `cost({input 20,000, output 3 x MAX_OUTPUT_TOKENS}, strong model)`, from the eval pricing.
 */
import { cost, PRICING_VERIFIED_AT } from "../llm/pricing.js";
import { MAX_OUTPUT_TOKENS } from "../modules/intent/index.js";

export { PRICING_VERIFIED_AT };

export const INPUT_TOKENS_BOUND = 20_000;
/** Characters that keep a prompt under the input bound (about 4 characters per token, 2x slack). */
export const MAX_SCENARIO_CHARS = 40_000;

export function runCostBoundUsd(strongModel: string): number {
  const c = cost(
    {
      inputTokens: INPUT_TOKENS_BOUND,
      outputTokens: 3 * MAX_OUTPUT_TOKENS,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    strongModel,
  );
  // An unpriced model: use a deliberately high bound so the guard stays on the safe side.
  return c ?? 1;
}

/** Number of model runs a scenario is expected to cause. */
export type RunCounts = Record<string, number>;

export interface BudgetState {
  maxUsd: number;
  spentUsd: number;
}

/**
 * True when a scenario whose bound is `boundUsd` may start. The boundary is exclusive of the
 * limit being crossed: `spent + bound === max` still runs (U-LIVE-COST-1).
 */
export function mayStart(b: BudgetState, boundUsd: number): boolean {
  return b.spentUsd + boundUsd <= b.maxUsd;
}
