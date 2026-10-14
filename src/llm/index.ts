import type { Config } from "../config/index.js";
import type { Logger } from "../core/logger.js";
import { createAnthropicLlm } from "./anthropic.js";
import type { LlmClient } from "./types.js";
import { unconfiguredLlm } from "./unconfigured.js";

export { createAnthropicLlm } from "./anthropic.js";
export * from "./types.js";
export { unconfiguredLlm } from "./unconfigured.js";

/** The API client when a key is configured, otherwise the one that always fails `not_configured`. */
export function createLlmClient(
  config: Pick<Config, "anthropicApiKey" | "llmMaxRetries" | "llmRefusalFallback">,
  log: Logger,
): LlmClient {
  if (config.anthropicApiKey) {
    log.info("llm client: anthropic");
    return createAnthropicLlm({
      apiKey: config.anthropicApiKey,
      maxRetries: config.llmMaxRetries,
      refusalFallback: config.llmRefusalFallback,
      log,
    });
  }
  log.info("llm client: unconfigured");
  return unconfiguredLlm();
}
