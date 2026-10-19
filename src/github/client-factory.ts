import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import {
  type Feature,
  installMutationGuard,
  type MutationGate,
  type MutationRefusedError,
  refuseAllGate,
} from "./mutation-guard.js";

export type GitHubClient = InstanceType<typeof Octokit>;

export interface GitHubClientFactory {
  /**
   * Every client has the mutation guard installed. Without `feature` it can make Phase 0 writes
   * only; a Phase 1 write needs the feature it acts for (`"guard"` or `"mcp"`) and a mode that
   * permits it (D11).
   */
  forInstallation(installationId: number, opts?: { feature?: Feature }): Promise<GitHubClient>;
  /** JWT-authenticated. Guarded too: it makes no writes of its own. */
  asApp(): GitHubClient;
}

export function createGitHubClientFactory(o: {
  appId: number;
  privateKey: string;
  baseUrl: string;
  /** Phase 1 write permission lookup. Without one, no Phase 1 write is ever allowed. */
  gate?: MutationGate;
  /** Told about each refused write (the bootstrap logs it at error). */
  onRefused?: (e: MutationRefusedError) => void;
  fetch?: typeof fetch;
}): GitHubClientFactory {
  const OctokitWithDefaults = Octokit.defaults({
    baseUrl: o.baseUrl,
    ...(o.fetch ? { request: { fetch: o.fetch } } : {}),
  });
  const app = new App({
    appId: o.appId,
    privateKey: o.privateKey,
    Octokit: OctokitWithDefaults,
  });
  const gate = o.gate ?? refuseAllGate;
  const appClient = app.octokit as unknown as GitHubClient;
  installMutationGuard(appClient, {
    installationId: null,
    feature: undefined,
    gate,
    ...(o.onRefused ? { onRefused: o.onRefused } : {}),
  });
  return {
    // @octokit/app caches installation tokens (until close to expiry) inside the auth strategy.
    async forInstallation(installationId, opts) {
      const client = (await app.getInstallationOctokit(installationId)) as unknown as GitHubClient;
      installMutationGuard(client, {
        installationId,
        feature: opts?.feature,
        gate,
        ...(o.onRefused ? { onRefused: o.onRefused } : {}),
      });
      return client;
    },
    asApp: () => appClient,
  };
}

/**
 * A client that authenticates with a plain token (a user's token, for the e2e runner and the
 * `baseline --auth token` dry run). Like the factory above, this file is the only place an
 * Octokit is built.
 */
export function forToken(
  token: string,
  o: { baseUrl?: string; fetch?: typeof fetch } = {},
): GitHubClient {
  const quiet = () => undefined;
  return new Octokit({
    auth: token,
    // Expected 404s (a missing file, an invitation not accepted yet) must not print warnings.
    log: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
    ...(o.fetch ? { request: { fetch: o.fetch } } : {}),
  });
}

/** Refuses every request that is not a GET or HEAD before it is sent. */
export function makeGetOnly(
  octokit: GitHubClient,
  onRequest?: (method: string, url: string) => void,
): GitHubClient {
  octokit.hook.before("request", (options) => {
    const method = String(options.method).toUpperCase();
    // Logged first, so a refused write still shows in the log.
    onRequest?.(method, String(options.url));
    if (method !== "GET" && method !== "HEAD") {
      throw new Error(`read-only client refused ${method} ${String(options.url)}`);
    }
  });
  return octokit;
}

/** An App-JWT client for an App id and key (the e2e runner's `app` client). */
export function forApp(o: {
  appId: number;
  privateKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
}): GitHubClient {
  return createGitHubClientFactory(o).asApp();
}
