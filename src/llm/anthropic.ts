import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../core/logger.js";
import {
  type LlmClient,
  type LlmFailure,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
  ZERO_USAGE,
} from "./types.js";

export interface AnthropicLlmOptions {
  apiKey: string;
  maxRetries: number;
  refusalFallback: boolean;
  log: Logger;
  /** Tests only. */
  fetch?: typeof fetch;
  /** Tests only. */
  baseURL?: string;
}

/** D5: the server-side refusal fallback exists for Sonnet and Opus only. */
const FALLBACK_MODEL = /^claude-(sonnet|opus)-/;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

interface ResponseLike {
  content: readonly { type: string; text?: string }[];
  stop_reason: string | null;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

function classify(err: unknown): LlmFailure {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (err instanceof Anthropic.APIUserAbortError) return "timeout"; // our deadline signal
  if (err instanceof Anthropic.APIConnectionError) return "unavailable";
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === undefined) return "unavailable";
    if (status === 429) return "rate_limited";
    if (status >= 500) return "unavailable";
    if (status === 401 || status === 403) return "auth";
    return "bad_request";
  }
  throw err; // a programmer error, not an API outcome
}

export function createAnthropicLlm(o: AnthropicLlmOptions): LlmClient {
  const client = new Anthropic({
    apiKey: o.apiKey,
    maxRetries: o.maxRetries,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.baseURL ? { baseURL: o.baseURL } : {}),
  });

  return {
    async complete(req: LlmRequest): Promise<LlmResult> {
      const started = Date.now();
      const finish = (
        r: { ok: true; value: unknown } | { ok: false; failure: LlmFailure },
        usage: LlmUsage,
        model: string,
      ): LlmResult => {
        const durationMs = Date.now() - started;
        // Metadata only: never the prompts, the request body, the output or the SDK error object.
        o.log.info(
          {
            purpose: req.purpose,
            model,
            ok: r.ok,
            ...(r.ok ? {} : { failure: r.failure }),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            durationMs,
          },
          "llm call",
        );
        return r.ok
          ? { ok: true, value: r.value, usage, model, durationMs }
          : { ok: false, failure: r.failure, usage, model, durationMs };
      };

      const body = {
        model: req.model,
        max_tokens: req.maxOutputTokens,
        system: [
          {
            type: "text" as const,
            text: req.system,
            cache_control: { type: "ephemeral" as const },
          },
        ],
        messages: [{ role: "user" as const, content: req.user }],
        output_config: {
          effort: req.effort,
          format: { type: "json_schema" as const, schema: req.outputSchema },
        },
      };
      // The SDK's `timeout` is per attempt and it retries: the signal bounds the whole call.
      const reqOpts = {
        timeout: req.timeoutMs,
        maxRetries: o.maxRetries,
        signal: AbortSignal.timeout(Math.max(1, Math.floor(req.deadlineMs ?? req.timeoutMs))),
      };

      let res: ResponseLike;
      try {
        res =
          o.refusalFallback && FALLBACK_MODEL.test(req.model)
            ? await client.beta.messages.create(
                { ...body, betas: [FALLBACK_BETA], fallbacks: "default" },
                reqOpts,
              )
            : await client.messages.create(body, reqOpts);
      } catch (err) {
        const failure = classify(err); // rethrows anything that is not an API outcome
        o.log.warn(
          {
            purpose: req.purpose,
            model: req.model,
            status: err instanceof Anthropic.APIError ? err.status : undefined,
            name: err instanceof Error ? err.name : "unknown",
          },
          "llm call failed",
        );
        return finish({ ok: false, failure }, ZERO_USAGE, req.model);
      }

      const usage: LlmUsage = {
        inputTokens: res.usage.input_tokens ?? 0,
        outputTokens: res.usage.output_tokens ?? 0,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      };
      const model = res.model || req.model;
      if (res.stop_reason === "refusal")
        return finish({ ok: false, failure: "refusal" }, usage, model);
      if (res.stop_reason === "max_tokens") {
        return finish({ ok: false, failure: "max_tokens" }, usage, model);
      }
      // A `fallback` block marks where one model's output gives way to the next: only the text
      // after the last one is the answer (what came before may be a decliner's partial output).
      let from = 0;
      res.content.forEach((b, i) => {
        if (b.type === "fallback") from = i + 1;
      });
      const text = res.content
        .slice(from)
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return finish({ ok: false, failure: "invalid_json" }, usage, model);
      }
      return finish({ ok: true, value }, usage, model);
    },
  };
}
