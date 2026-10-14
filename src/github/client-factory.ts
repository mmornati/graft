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
