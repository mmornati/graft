/**
 * The model boundary (step 3, D1). Modules never build SDK clients: they receive an `LlmClient`
 * through `JobContext.llm`. `complete` returns a result for every API outcome (success, timeout,
 * rate limit, refusal, bad JSON, ...) and throws only on programmer errors.
 *
 * Never log `system`, `user` or `value`: they contain diffs, PR text and model output.
 */
/**
 * A Claude model ID, optionally with the vendor prefix and version suffix a gateway or cloud uses:
 * `claude-sonnet-5-5`, `anthropic/claude-sonnet-5.5` (OpenRouter), `us.anthropic.claude-...:0`.
 */
export const MODEL_ID = /^(?:[a-z0-9-]{1,30}[./]){0,3}claude-[a-z0-9.-]{1,60}(?::[a-z0-9]{1,10})?$/;

export type LlmPurpose = "writer" | "writer_escalated" | "verifier";
export type LlmEffort = "low" | "medium" | "high";

export interface LlmRequest {
  purpose: LlmPurpose;
  model: string;
  /** Stable per PROMPT_VERSION; sent with cache_control. */
  system: string;
  /** Contains untrusted data blocks; NEVER logged. */
  user: string;
  /**
   * A prefix of `user` sent as its own block with cache_control, so calls that start with the
   * same bytes (same model and effort) read it from the cache. Must be non-empty when set.
   */
  userCachePrefix?: string;
  /** JSON Schema for output_config.format. */
  outputSchema: Record<string, unknown>;
  maxOutputTokens: number;
  effort: LlmEffort;
  /** Per attempt. */
  timeoutMs: number;
  /**
   * Wall-clock limit for the whole call, SDK retries and their backoff included. Defaults to the
   * per-attempt timeout.
   */
  deadlineMs?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type LlmFailure =
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "auth"
  | "bad_request"
  | "refusal"
  | "max_tokens"
  | "invalid_json"
  | "not_configured";

export type LlmResult =
  | { ok: true; value: unknown; usage: LlmUsage; model: string; durationMs: number }
  | { ok: false; failure: LlmFailure; usage: LlmUsage; model: string; durationMs: number };

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResult>;
  /**
   * True when this client already retries a refused call on another model server-side, so the
   * caller must not add its own refusal fallback. Absent means false.
   */
  serverRefusalFallback?(model: string): boolean;
}

export const ZERO_USAGE: LlmUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
