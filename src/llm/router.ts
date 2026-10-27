import { costAt, priceFor } from "./pricing.js";
import { type LlmProvider, splitModelRef } from "./registry.js";
import {
  FULL_CAPABILITIES,
  type LlmCapabilities,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
} from "./types.js";

/**
 * The cost of one call on a provider-qualified model: the entry's prices first, then the built-in
 * Claude table for Anthropic-format providers; null when unpriced or the provider is unknown.
 */
export function registryCostOf(
  providers: readonly LlmProvider[],
): (usage: LlmUsage, ref: string) => number | null {
  const byId = new Map(providers.map((p) => [p.id, p]));
  return (usage, ref) => {
    const split = splitModelRef(ref);
    const p = split ? byId.get(split.provider) : undefined;
    if (!split || !p) return null;
    const price =
      priceFor(split.model, p.prices) ?? (p.kind === "anthropic" ? priceFor(split.model) : null);
    return price ? costAt(usage, price) : null;
  };
}

export interface RoutedProvider {
  readonly provider: LlmProvider;
  readonly client: LlmClient;
}

/**
 * One `LlmClient` over several providers. A request's model is `<provider id>/<model>`: the
 * provider gets the bare model, and the result's model is qualified again, so the card, the logs
 * and the spend ledger name the provider. A model naming no configured provider is a programmer
 * error (the config checks every role), so it throws.
 *
 * A Copilot provider serves only the installations that opted in: for any other installation, or
 * a call with none (the eval tool), the call goes to the model its `fallbackModels` names, and the
 * card names that model.
 */
export function createRouterLlm(routes: readonly RoutedProvider[]): LlmClient {
  const byId = new Map(routes.map((r) => [r.provider.id, r]));
  const costOf = registryCostOf(routes.map((r) => r.provider));
  const route = (
    ref: string,
    installationId: number | undefined,
  ): { r: RoutedProvider; model: string } => {
    const split = splitModelRef(ref);
    const r = split ? byId.get(split.provider) : undefined;
    if (!split || !r) throw new Error("model names no configured provider");
    const p = r.provider;
    if (
      p.kind === "copilot" &&
      (installationId === undefined || !p.installations.has(installationId))
    ) {
      const fallback = p.fallbackModels[split.model];
      if (fallback === undefined) throw new Error("copilot model has no fallback");
      return route(fallback, installationId); // never copilot again: the config checks it
    }
    return { r, model: split.model };
  };

  return {
    async complete(req: LlmRequest): Promise<LlmResult> {
      const { r, model } = route(req.model, req.installationId);
      const res = await r.client.complete({ ...req, model });
      return { ...res, model: `${r.provider.id}/${res.model}` };
    },
    serverRefusalFallback(ref: string, installationId?: number): boolean {
      const { r, model } = route(ref, installationId);
      return r.client.serverRefusalFallback?.(model) ?? false;
    },
    capabilities(ref: string, installationId?: number): LlmCapabilities {
      const { r, model } = route(ref, installationId);
      return r.client.capabilities?.(model) ?? r.provider.capabilities ?? FULL_CAPABILITIES;
    },
    costOf(usage: LlmUsage, ref: string): number | null {
      route(ref, undefined); // an unknown provider is a programmer error here too
      return costOf(usage, ref);
    },
  };
}
