import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";

export type GitHubClient = InstanceType<typeof Octokit>;

export interface GitHubClientFactory {
  forInstallation(installationId: number): Promise<GitHubClient>;
  /** JWT-authenticated. */
  asApp(): GitHubClient;
}

export function createGitHubClientFactory(o: {
  appId: number;
  privateKey: string;
  baseUrl: string;
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
  return {
    // @octokit/app caches installation tokens (until close to expiry) inside the auth strategy.
    forInstallation: (installationId) =>
      app.getInstallationOctokit(installationId) as Promise<GitHubClient>,
    asApp: () => app.octokit as unknown as GitHubClient,
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
