import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { recordLlmCall } from "../telemetry/metrics.js";
import { withSpan } from "../telemetry/tracing.js";
import type { LlmClient, LlmRequest, LlmResult } from "./types.js";

/**
 * `gen_ai.provider.name` for a provider kind: the OpenTelemetry GenAI value where one exists,
 * the kind itself otherwise.
 */
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "anthropic",
  "openai-compatible": "openai",
  "vertex-ai": "gcp.vertex_ai",
  copilot: "github_copilot",
};

export function genAiProviderName(kind: string): string {
  return PROVIDER_NAMES[kind] ?? kind;
}

/**
 * One CLIENT span per model call, with the OpenTelemetry GenAI attributes: provider, models,
 * token counts and Graft's purpose and outcome. Never the prompts or the output.
 */
export function tracedLlm(client: LlmClient, provider: { kind: string; id?: string }): LlmClient {
  const providerName = genAiProviderName(provider.kind);
  const traced: LlmClient = {
    complete(req: LlmRequest): Promise<LlmResult> {
      return withSpan(
        `chat ${req.model}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": providerName,
            "gen_ai.request.model": req.model,
            "gen_ai.request.max_tokens": req.maxOutputTokens,
            "graft.llm.purpose": req.purpose,
            "graft.llm.effort": req.effort,
            ...(provider.id ? { "graft.llm.provider_id": provider.id } : {}),
          },
        },
        async (span) => {
          const res = await client.complete(req);
          recordLlmCall(
            {
              "gen_ai.operation.name": "chat",
              "gen_ai.provider.name": providerName,
              "gen_ai.request.model": req.model,
              "graft.llm.purpose": req.purpose,
            },
            {
              seconds: res.durationMs / 1000,
              failure: res.ok ? null : res.failure,
              usage: res.usage,
            },
          );
          span.setAttributes({
            "gen_ai.response.model": res.model,
            "gen_ai.usage.input_tokens": res.usage.inputTokens,
            "gen_ai.usage.output_tokens": res.usage.outputTokens,
            "gen_ai.usage.cache_read.input_tokens": res.usage.cacheReadTokens,
            "gen_ai.usage.cache_creation.input_tokens": res.usage.cacheWriteTokens,
            "graft.llm.outcome": res.ok ? "ok" : res.failure,
          });
          if (!res.ok) {
            span.setAttribute("error.type", res.failure);
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          return res;
        },
      );
    },
  };
  // The optional methods, only when the client has them: absent means a default to callers.
  if (client.serverRefusalFallback) {
    traced.serverRefusalFallback = client.serverRefusalFallback.bind(client);
  }
  if (client.capabilities) traced.capabilities = client.capabilities.bind(client);
  if (client.costOf) traced.costOf = client.costOf.bind(client);
  if (client.priceVersion) traced.priceVersion = client.priceVersion.bind(client);
  if (client.priceSnapshot) traced.priceSnapshot = client.priceSnapshot.bind(client);
  return traced;
}
