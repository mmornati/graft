import { type LlmClient, ZERO_USAGE } from "./types.js";

/** Used when there is no API key: every call fails with `not_configured`. */
export function unconfiguredLlm(): LlmClient {
  return {
    async complete(req) {
      return {
        ok: false,
        failure: "not_configured",
        usage: ZERO_USAGE,
        model: req.model,
        durationMs: 0,
      };
    },
  };
}
