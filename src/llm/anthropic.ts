import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../core/logger.js";
import { type AnthropicFederation, FederationError, federatedCredentials } from "./federation.js";
import {
  FULL_CAPABILITIES,
  type LlmCapabilities,
  type LlmClient,
  type LlmFailure,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
  ZERO_USAGE,
} from "./types.js";

/**
 * Exactly one of `apiKey` (sent as `x-api-key`), `authToken` (sent as `Authorization: Bearer`) and
 * `federation` (an OIDC token exchanged for a short-lived bearer token). None falls back to the
 * process environment: the validated config is the only source.
 */
export type AnthropicCredential =
  | { apiKey: string; authToken?: undefined; federation?: undefined }
  | { apiKey?: undefined; authToken: string; federation?: undefined }
  | { apiKey?: undefined; authToken?: undefined; federation: AnthropicFederation };

/** The configured credential, or null when none is (the config allows at most one). */
export function anthropicCredential(c: {
  anthropicApiKey: string | undefined;
  anthropicAuthToken: string | undefined;
  anthropicFederation: AnthropicFederation | undefined;
}): AnthropicCredential | null {
  if (c.anthropicApiKey) return { apiKey: c.anthropicApiKey };
  if (c.anthropicAuthToken) return { authToken: c.anthropicAuthToken };
  if (c.anthropicFederation) return { federation: c.anthropicFederation };
  return null;
}

const CLAUDE_API = "https://api.anthropic.com";

export interface AnthropicSettings {
  maxRetries: number;
  /** Server-side refusal fallback; only the Claude API offers it (see `isClaudeApi`). */
  refusalFallback: boolean;
  /** Messages API base URL; undefined means the Claude API. */
  baseURL?: string;
  /**
   * What the endpoint supports; defaults to everything. A gateway or cloud without structured
   * outputs (Bedrock Mantle) gets no `output_config.format`, and so on for effort and caching.
   */
  capabilities?: LlmCapabilities;
}

export type AnthropicLlmOptions = AnthropicCredential &
  AnthropicSettings & {
    log: Logger;
    /** Tests only. */
    fetch?: typeof fetch;
  };

/**
 * Server-side refusal fallback is a Claude API feature: Bedrock, Google Cloud, Microsoft Foundry
 * and the gateways do not offer it.
 */
export function isClaudeApi(baseURL: string | undefined): boolean {
  return baseURL === undefined || new URL(baseURL).hostname === "api.anthropic.com";
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
  if (err instanceof FederationError) return err.failure; // the token exchange, before the call
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
    apiKey: o.apiKey ?? null,
    authToken: o.authToken ?? null,
    baseURL: o.baseURL ?? null,
    // The token is exchanged against the same host as the calls and cached until near expiry.
    ...(o.federation
      ? {
          credentials: federatedCredentials(
            o.federation,
            o.baseURL ?? CLAUDE_API,
            o.fetch ?? fetch,
          ),
        }
      : {}),
    maxRetries: o.maxRetries,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const serverRefusalFallback = (model: string) => o.refusalFallback && FALLBACK_MODEL.test(model);
  const caps = o.capabilities ?? FULL_CAPABILITIES;
  const cacheControl = caps.promptCache ? { cache_control: { type: "ephemeral" as const } } : {};

  return {
    serverRefusalFallback,
    capabilities: () => caps,
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

      const prefix = req.userCachePrefix;
      if (prefix !== undefined && (prefix === "" || !req.user.startsWith(prefix))) {
        throw new Error("userCachePrefix must be a non-empty prefix of user");
      }
      const rest = prefix === undefined ? "" : req.user.slice(prefix.length);
      const content =
        prefix === undefined
          ? req.user
          : [
              { type: "text" as const, text: prefix, ...cacheControl },
              ...(rest === "" ? [] : [{ type: "text" as const, text: rest }]),
            ];
      const body = {
        model: req.model,
        max_tokens: req.maxOutputTokens,
        system: [{ type: "text" as const, text: req.system, ...cacheControl }],
        messages: [{ role: "user" as const, content }],
        ...(caps.effort || caps.nativeSchema
          ? {
              output_config: {
                ...(caps.effort ? { effort: req.effort } : {}),
                ...(caps.nativeSchema
                  ? { format: { type: "json_schema" as const, schema: req.outputSchema } }
                  : {}),
              },
            }
          : {}),
      };
      // The SDK's `timeout` is per attempt and it retries: the signal bounds the whole call.
      const reqOpts = {
        timeout: req.timeoutMs,
        maxRetries: o.maxRetries,
        signal: AbortSignal.timeout(Math.max(1, Math.floor(req.deadlineMs ?? req.timeoutMs))),
      };

      let res: ResponseLike;
      try {
        res = serverRefusalFallback(req.model)
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
            status:
              err instanceof Anthropic.APIError || err instanceof FederationError
                ? err.status
                : undefined,
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
