/** USD per million tokens (T12). Check against Anthropic's pricing page before a live run. */
import type { LlmUsage } from "../llm/types.js";

export const PRICING_VERIFIED_AT = "2026-10-06";

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Haiku's higher rate above 100K prompt tokens is not modelled: Graft prompts stay below 60K
// (120,000 diff characters plus 28,000 for text).
export const PRICES: Readonly<Record<string, Price>> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
};

/** Longest-prefix match: `response.model` may carry a date suffix. */
export function priceFor(model: string): Price | null {
  let best: string | null = null;
  for (const id of Object.keys(PRICES)) {
    if (
      (model === id || model.startsWith(`${id}-`)) &&
      (best === null || id.length > best.length)
    ) {
      best = id;
    }
  }
  return best === null ? null : (PRICES[best] as Price);
}

export function cost(usage: LlmUsage, model: string): number | null {
  const p = priceFor(model);
  if (!p) return null;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1e6
  );
}

export const roundUsd = (x: number): number => Math.round(x * 1e8) / 1e8;

/** Sum over calls; unknown models contribute nothing. */
export function costOfCalls(calls: readonly { model: string; usage: LlmUsage }[]): number {
  return roundUsd(calls.reduce((sum, c) => sum + (cost(c.usage, c.model) ?? 0), 0));
}
