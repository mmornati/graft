import type { Config } from "../config/index.js";
import type { Logger } from "../core/logger.js";
import { anthropicCredential, createAnthropicLlm, isClaudeApi } from "./anthropic.js";
import type { LlmClient } from "./types.js";
import { unconfiguredLlm } from "./unconfigured.js";

export { anthropicCredential, createAnthropicLlm, isClaudeApi } from "./anthropic.js";
export { type AnthropicFederation, FederationError } from "./federation.js";
export * from "./types.js";
export { unconfiguredLlm } from "./unconfigured.js";

/**
 * The Messages API client when a key, a token or federation is configured, otherwise the one that
 * always fails `not_configured`. A base URL points it at a gateway or cloud that speaks the same API.
 */
export function createLlmClient(
  config: Pick<
    Config,
    | "anthropicApiKey"
    | "anthropicAuthToken"
    | "anthropicFederation"
    | "anthropicBaseUrl"
    | "llmMaxRetries"
    | "llmRefusalFallback"
  >,
  log: Logger,
): LlmClient {
  const credential = anthropicCredential(config);
  if (credential) {
    // The host only, never the whole URL: it could carry credentials. Of the federation settings
    // only the rule ID is logged; never the identity token, its path or the exchanged token.
    const host = config.anthropicBaseUrl ? new URL(config.anthropicBaseUrl).host : "default";
    log.info(
      credential.federation
        ? { host, auth: "federation", federationRuleId: credential.federation.ruleId }
        : { host, auth: credential.apiKey ? "api_key" : "auth_token" },
      "llm client: anthropic",
    );
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
