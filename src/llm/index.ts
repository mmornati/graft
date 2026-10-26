import type { Config } from "../config/index.js";
import type { Logger } from "../core/logger.js";
import { anthropicCredential, createAnthropicLlm, isClaudeApi } from "./anthropic.js";
import { createOpenAiCompatibleLlm } from "./openai-compatible.js";
import type { LlmProvider } from "./registry.js";
import { createRouterLlm } from "./router.js";
import type { LlmClient } from "./types.js";
import { unconfiguredLlm } from "./unconfigured.js";

export { anthropicCredential, createAnthropicLlm, isClaudeApi } from "./anthropic.js";
export { type AnthropicFederation, FederationError } from "./federation.js";
export { createOpenAiCompatibleLlm, parseJsonAnswer } from "./openai-compatible.js";
export {
  type LlmProvider,
  type LlmRegistry,
  type LlmRoles,
  parseRegistry,
  splitModelRef,
} from "./registry.js";
export { createRouterLlm } from "./router.js";
export * from "./types.js";
export { unconfiguredLlm } from "./unconfigured.js";

/**
 * With a provider registry, a router over one client per provider. Without one, exactly what Graft
 * did before the registry: the Messages API client when a key, a token or federation is configured,
 * otherwise the one that always fails `not_configured`. A base URL points it at a gateway or cloud
 * that speaks the same API.
 */
export function createLlmClient(
  config: Pick<
    Config,
    | "llmRegistry"
    | "anthropicApiKey"
    | "anthropicAuthToken"
    | "anthropicFederation"
    | "anthropicBaseUrl"
    | "llmMaxRetries"
    | "llmRefusalFallback"
  >,
  log: Logger,
): LlmClient {
  if (config.llmRegistry) {
    const { providers, roles } = config.llmRegistry;
    log.info(
      { providers: providers.map(describeProvider), roles: { ...roles } },
      "llm client: registry",
    );
    return createRouterLlm(
      providers.map((provider) => ({
        provider,
        client: providerClient(provider, config, log.child({ provider: provider.id })),
      })),
    );
  }
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

/** What is safe to log about a provider: never a credential or a whole URL. */
function describeProvider(p: LlmProvider) {
  return {
    id: p.id,
    kind: p.kind,
    host: p.baseUrl ? new URL(p.baseUrl).host : "default",
    auth: p.sharedCredential ? "shared" : "own",
  };
}

function providerClient(
  p: LlmProvider,
  config: Pick<Config, "llmMaxRetries" | "llmRefusalFallback">,
  log: Logger,
): LlmClient {
  switch (p.kind) {
    case "anthropic":
      return createAnthropicLlm({
        ...p.credential(),
        ...(p.baseUrl ? { baseURL: p.baseUrl } : {}),
        maxRetries: config.llmMaxRetries,
        refusalFallback: config.llmRefusalFallback && isClaudeApi(p.baseUrl),
        capabilities: p.capabilities,
        log,
      });
    case "openai-compatible":
      return createOpenAiCompatibleLlm({
        baseURL: p.baseUrl,
        apiKey: p.credential(),
        maxRetries: config.llmMaxRetries,
        capabilities: p.capabilities,
        zeroRetention: p.zeroRetention,
        maxTokensParam: p.maxTokensParam,
        log,
      });
  }
}
