/** D11: the first card decides the LLM mode in `auto`. */
import type { CardObs } from "./observe.js";
import type { LlmMode, RunCtx } from "./types.js";

export class LlmStop extends Error {
  constructor(readonly reason: string) {
    super(`the first card is unavailable for a reason other than a missing key: ${reason}`);
    this.name = "LlmStop";
  }
}

/**
 * `status = 'ok'` means live; `failure_reason = 'not_configured'` means none; anything else stops
 * the run (`llm_auth`, `budget_exceeded`, ...). `--llm live|none` forces the mode.
 */
export function modeFromCard(card: Pick<CardObs, "status" | "failureReason"> | null): LlmMode {
  if (card === null) throw new LlmStop("no card");
  if (card.status === "ok") return "live";
  if (card.failureReason === "not_configured") return "none";
  throw new LlmStop(card.failureReason ?? "unknown");
}

export function decideLlmMode(run: RunCtx, card: CardObs | null): LlmMode {
  if (run.opts.llm !== "auto") {
    run.llmMode = run.opts.llm;
    return run.llmMode;
  }
  run.llmMode = modeFromCard(card);
  return run.llmMode;
}
