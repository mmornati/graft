import OpenAI from "openai";
import type { Logger } from "../core/logger.js";
import {
  type LlmCapabilities,
  type LlmClient,
  type LlmFailure,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
  ZERO_USAGE,
} from "./types.js";

/**
 * The OpenAI Chat Completions format: OpenAI, OpenRouter, Mistral, DeepSeek, Gemini's compatible
 * endpoint, and local servers (Ollama, vLLM, LM Studio, llama.cpp, the LiteLLM proxy). Its default
 * capabilities are in `src/llm/registry.ts`.
 */
export interface OpenAiCompatibleOptions {
  /** Chat Completions base URL, for example `http://ollama:11434/v1`. */
  baseURL: string;
  /** Sent as a bearer token; undefined for a local server that needs none. */
  apiKey: string | undefined;
  maxRetries: number;
  capabilities: LlmCapabilities;
  /** OpenRouter only: ask for zero-data-retention endpoints and no data collection. */
  zeroRetention: boolean;
  /**
   * The output-token limit field. OpenAI's own API wants `max_completion_tokens` (its reasoning
   * models refuse `max_tokens`); most other servers only know `max_tokens`.
   */
  maxTokensParam: "max_tokens" | "max_completion_tokens";
  log: Logger;
  /** Tests only. */
  fetch?: typeof fetch;
}

export function isOpenAiApi(baseURL: string): boolean {
  return new URL(baseURL).hostname === "api.openai.com";
}

function isOpenRouter(baseURL: string): boolean {
  return new URL(baseURL).hostname === "openrouter.ai";
}

function classify(err: unknown): LlmFailure {
  if (err instanceof OpenAI.APIConnectionTimeoutError) return "timeout";
  if (err instanceof OpenAI.APIUserAbortError) return "timeout"; // our deadline signal
  if (err instanceof OpenAI.APIConnectionError) return "unavailable";
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (status === undefined) return "unavailable";
    if (status === 429) return "rate_limited";
    if (status >= 500) return "unavailable";
    if (status === 401 || status === 403) return "auth";
    return "bad_request";
  }
  throw err; // a programmer error, not an API outcome
}

/**
 * The answer's JSON. A model that was only told about the schema in the prompt sometimes wraps it
 * in a Markdown fence: one fence around the whole answer is removed, nothing else is repaired.
 */
export function parseJsonAnswer(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(trimmed);
  try {
    return { ok: true, value: JSON.parse(fenced ? (fenced[1] as string) : trimmed) };
  } catch {
    return { ok: false };
  }
}

interface CompletionLike {
  model?: string;
  choices?: readonly {
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number | null } | null;
  } | null;
}

export function createOpenAiCompatibleLlm(o: OpenAiCompatibleOptions): LlmClient {
  // Every option the SDK would otherwise take from OPENAI_* variables is passed explicitly, and
  // its own logging is off (at debug it prints request bodies). OPENAI_CUSTOM_HEADERS is the one
  // variable it still reads; it is the operator's, like the rest of the environment.
  const client = new OpenAI({
    // The SDK refuses to start without a key; a local server ignores the placeholder.
    apiKey: o.apiKey ?? "no-key",
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    baseURL: o.baseURL,
    maxRetries: o.maxRetries,
    logLevel: "off",
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const caps = o.capabilities;
  const openRouter = isOpenRouter(o.baseURL);

  return {
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

      // Same contract as the Anthropic client, though caching here is the server's business.
      const prefix = req.userCachePrefix;
      if (prefix !== undefined && (prefix === "" || !req.user.startsWith(prefix))) {
        throw new Error("userCachePrefix must be a non-empty prefix of user");
      }

      // Strict mode wants an object at the root; Graft's combined schema is an `anyOf`.
      const strict = req.outputSchema.type === "object";
      const body = {
        model: req.model,
        messages: [
          { role: "system" as const, content: req.system },
          { role: "user" as const, content: req.user },
        ],
        [o.maxTokensParam]: req.maxOutputTokens,
        ...(caps.nativeSchema
          ? {
              response_format: {
                type: "json_schema" as const,
                json_schema: { name: "graft_output", schema: req.outputSchema, strict },
              },
            }
          : {}),
        ...(caps.effort ? { reasoning_effort: req.effort } : {}),
        ...(openRouter
          ? {
              provider: {
                require_parameters: true,
                ...(o.zeroRetention ? { zdr: true, data_collection: "deny" } : {}),
              },
            }
          : {}),
      };
      const reqOpts = {
        timeout: req.timeoutMs,
        maxRetries: o.maxRetries,
        signal: AbortSignal.timeout(Math.max(1, Math.floor(req.deadlineMs ?? req.timeoutMs))),
      };

      let res: CompletionLike;
      try {
        res = (await client.chat.completions.create(
          body as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
          reqOpts,
        )) as CompletionLike;
      } catch (err) {
        const failure = classify(err); // rethrows anything that is not an API outcome
        o.log.warn(
          {
            purpose: req.purpose,
            model: req.model,
            status: err instanceof OpenAI.APIError ? err.status : undefined,
            name: err instanceof Error ? err.name : "unknown",
          },
          "llm call failed",
        );
        return finish({ ok: false, failure }, ZERO_USAGE, req.model);
      }

      // Anthropic counts cache reads apart from input; OpenAI includes them in prompt_tokens.
      const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const usage: LlmUsage = caps.reportsUsage
        ? {
            inputTokens: Math.max(0, (res.usage?.prompt_tokens ?? 0) - cached),
            outputTokens: res.usage?.completion_tokens ?? 0,
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
          }
        : ZERO_USAGE;
      const model = res.model || req.model;
      const choice = res.choices?.[0];
      if (!choice) return finish({ ok: false, failure: "invalid_json" }, usage, model);
      if (choice.message?.refusal || choice.finish_reason === "content_filter") {
        return finish({ ok: false, failure: "refusal" }, usage, model);
      }
      if (choice.finish_reason === "length") {
        return finish({ ok: false, failure: "max_tokens" }, usage, model);
      }
      const parsed = parseJsonAnswer(choice.message?.content ?? "");
      if (!parsed.ok) return finish({ ok: false, failure: "invalid_json" }, usage, model);
      return finish({ ok: true, value: parsed.value }, usage, model);
    },
  };
}
