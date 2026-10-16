import type { Config } from "../config/index.js";
import type { Logger } from "../core/logger.js";
import { createAnthropicLlm, isClaudeApi } from "./anthropic.js";
import type { LlmClient } from "./types.js";
import { unconfiguredLlm } from "./unconfigured.js";

export { createAnthropicLlm, isClaudeApi } from "./anthropic.js";
export * from "./types.js";
export { unconfiguredLlm } from "./unconfigured.js";

/**
 * The Messages API client when a key or token is configured, otherwise the one that always fails
 * `not_configured`. A base URL points it at a gateway or cloud that speaks the same API.
 */
export function createLlmClient(
  config: Pick<
    Config,
    | "anthropicApiKey"
    | "anthropicAuthToken"
    | "anthropicBaseUrl"
    | "llmMaxRetries"
    | "llmRefusalFallback"
  >,
  log: Logger,
): LlmClient {
  const credential = config.anthropicApiKey
    ? { apiKey: config.anthropicApiKey }
    : config.anthropicAuthToken
      ? { authToken: config.anthropicAuthToken }
      : null;
  if (credential) {
    // The host only, never the whole URL: it could carry credentials.
    const host = config.anthropicBaseUrl ? new URL(config.anthropicBaseUrl).host : "default";
    log.info({ host }, "llm client: anthropic");
    return createAnthropicLlm({
      ...credential,
      ...(config.anthropicBaseUrl ? { baseURL: config.anthropicBaseUrl } : {}),
      maxRetries: config.llmMaxRetries,
      refusalFallback: config.llmRefusalFallback && isClaudeApi(config.anthropicBaseUrl),
      log,
    });
  }
  log.info("llm client: unconfigured");
  return unconfiguredLlm();
}
