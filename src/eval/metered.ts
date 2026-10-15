/**
 * Records `{model, usage}` per call, because `CardResult.usage` is a sum over models and Haiku
 * and Sonnet differ 20x in price (E21).
 */
import type { LlmClient, LlmRequest, LlmResult, LlmUsage } from "../llm/types.js";

export interface MeteredCall {
  model: string;
  usage: LlmUsage;
}

export function meteredLlm(inner: LlmClient): { client: LlmClient; calls: MeteredCall[] } {
  const calls: MeteredCall[] = [];
  return {
    calls,
    client: {
      async complete(req: LlmRequest): Promise<LlmResult> {
        const res = await inner.complete(req);
        calls.push({ model: res.model || req.model, usage: { ...res.usage } });
        return res;
      },
    },
  };
}
