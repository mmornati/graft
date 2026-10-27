import path from "node:path";
import type { Config } from "../config/index.js";
import type { Logger } from "../core/logger.js";
import { anthropicCredential, createAnthropicLlm, isClaudeApi } from "./anthropic.js";
import { type CliAdapter, createCliLlm } from "./cli.js";
import { claudeCliAdapter } from "./cli-claude.js";
import { codexCliAdapter } from "./cli-codex.js";
import { opencodeCliAdapter } from "./cli-opencode.js";
import { type CopilotTokenSource, createCopilotLlm } from "./copilot.js";
import { createOpenAiCompatibleLlm } from "./openai-compatible.js";
import type { CliKind, LlmProvider, LlmRegistry } from "./registry.js";
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
  loadRegistry,
  parseRegistry,
  splitModelRef,
} from "./registry.js";
export { createRouterLlm, registryCostOf } from "./router.js";
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
  deps: LlmDeps = {},
): LlmClient {
  if (config.llmRegistry) return createRegistryLlm(config.llmRegistry, config, log, deps);
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

/** What some providers need from the rest of Graft. */
export interface LlmDeps {
  /** Mints an installation token with `copilot_requests: write`, for `copilot` providers. */
  copilotToken?: CopilotTokenSource;
}

/** A router over one client per registered provider. Also used by the eval tool. */
export function createRegistryLlm(
  registry: LlmRegistry,
  settings: Pick<Config, "llmMaxRetries" | "llmRefusalFallback">,
  log: Logger,
  deps: LlmDeps = {},
): LlmClient {
  log.info(
    { providers: registry.providers.map(describeProvider), roles: { ...registry.roles } },
    "llm client: registry",
  );
  return createRouterLlm(
    registry.providers.map((provider) => ({
      provider,
      client: providerClient(provider, settings, log.child({ provider: provider.id }), deps),
    })),
  );
}

const CLI_ADAPTERS: Record<CliKind, CliAdapter> = {
  "cli:claude": claudeCliAdapter,
  "cli:codex": codexCliAdapter,
  "cli:opencode": opencodeCliAdapter,
};

/** What is safe to log about a provider: never a credential or a whole URL. */
function describeProvider(p: LlmProvider) {
  return {
    id: p.id,
    kind: p.kind,
    host: p.baseUrl
      ? new URL(p.baseUrl).host
      : "command" in p
        ? "local"
        : p.kind === "copilot"
          ? "github"
          : "default",
    ...(p.kind === "copilot" ? { installations: p.installations.size } : {}),
    auth: p.sharedCredential ? "shared" : "own",
  };
}

function providerClient(
  p: LlmProvider,
  config: Pick<Config, "llmMaxRetries" | "llmRefusalFallback">,
  log: Logger,
  deps: LlmDeps,
): LlmClient {
  switch (p.kind) {
    case "copilot":
      return createCopilotLlm({
        capabilities: p.capabilities,
        // The eval tool has no installations: the router never sends it here.
        tokenFor:
          deps.copilotToken ?? (() => Promise.reject(new Error("no installation token source"))),
        passEnv: p.passEnv,
        log,
      });
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
    case "cli:claude":
    case "cli:codex":
    case "cli:opencode":
      log.warn(
        { command: path.basename(p.command) },
        "llm provider runs a CLI on a personal login: single-tenant self-hosted use only",
      );
      return createCliLlm({
        command: p.command,
        adapter: CLI_ADAPTERS[p.kind],
        capabilities: p.capabilities,
        passEnv: p.passEnv,
        log,
      });
  }
}
