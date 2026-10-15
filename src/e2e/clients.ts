/**
 * The runner's four Octokit clients (T6): `actor`, `outsider`, `app` (JWT) and `probe`
 * (installation token). All are built through `src/github/client-factory.ts`; each gets the write
 * guard, the rate-limit wrapper, a mutation spacer and, with `--capture`, an exchange recorder.
 */
import type { Config } from "../config/index.js";
import {
  createGitHubClientFactory,
  forToken,
  type GitHubClient,
  type GitHubClientFactory,
} from "../github/client-factory.js";
import { installRateLimit, type RateLimitStats } from "../github/rate-limit.js";
import { type ClientKind, checkRequest, type GuardContext, GuardRefusal } from "./guard.js";
import type { SecretRegistry } from "./secrets.js";

export interface Exchange {
  client: ClientKind;
  method: string;
  /** Octokit route template, e.g. `/repos/{owner}/{repo}/pulls/{pull_number}`. */
  route: string;
  path: string;
  query: Record<string, string>;
  status: number;
  requestBody?: unknown;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
}

export interface ClientOptions {
  config: Config;
  fetch?: typeof fetch | undefined;
  actorToken: string;
  outsiderToken?: string | undefined;
  guard: GuardContext;
  secrets: SecretRegistry;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Minimum gap between two non-GET requests of one token (GitHub's guidance: 1000 ms). */
  mutationSpacingMs: number;
  maxRequests: number;
  onExchange?: ((ex: Exchange) => void) | undefined;
}

export interface Clients {
  actor: GitHubClient;
  outsider: GitHubClient | undefined;
  app: GitHubClient;
  probe(installationId: number): Promise<GitHubClient>;
  /** Total requests over all clients. */
  requests(): number;
}

type HookOptions = Record<string, unknown> & { method: string; url: string };

interface Expanded {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

function expand(octokit: GitHubClient, options: HookOptions): Expanded {
  const endpoint = (
    octokit.request as unknown as {
      endpoint(o: unknown): { method: string; url: string; body?: unknown };
    }
  ).endpoint(options);
  let pathname = endpoint.url;
  let query: Record<string, string> = {};
  try {
    const u = new URL(endpoint.url, "https://example.invalid");
    pathname = decodeURIComponent(u.pathname);
    query = Object.fromEntries(u.searchParams);
  } catch {
    // keep the raw url
  }
  return { method: endpoint.method.toUpperCase(), path: pathname, query, body: endpoint.body };
}

const KEEP_HEADERS = /^(content-type|link|x-github-request-id|x-ratelimit-.*)$/i;

function instrument(
  octokit: GitHubClient,
  kind: ClientKind,
  o: ClientOptions,
  counter: { n: number },
): RateLimitStats {
  const spacing = { last: 0 };
  octokit.hook.before("request", async (options) => {
    const e = expand(octokit, options as unknown as HookOptions);
    checkRequest(kind, { method: e.method, path: e.path, body: e.body }, o.guard);
    // A redirect of a write must not be followed: it could land on another repository.
    if (e.method !== "GET" && e.method !== "HEAD") {
      const request = ((options as { request?: object }).request ?? {}) as object;
      (options as { request?: object }).request = { ...request, redirect: "manual" };
    }
    if (e.method !== "GET" && e.method !== "HEAD" && o.mutationSpacingMs > 0) {
      const wait = spacing.last + o.mutationSpacingMs - o.now();
      if (wait > 0) await o.sleep(wait);
      spacing.last = o.now();
    }
  });
  octokit.hook.after("request", async (response, options) => {
    counter.n += 1;
    const method = String((options as unknown as HookOptions).method).toUpperCase();
    if (method !== "GET" && method !== "HEAD" && response.status >= 300 && response.status < 400) {
      throw new GuardRefusal(`${method} was answered with a redirect (HTTP ${response.status})`);
    }
    // Learn the (installation) token or JWT in use, so it can be redacted.
    try {
      const auth = (await octokit.auth()) as { token?: string } | undefined;
      o.secrets.add(auth?.token);
    } catch {
      // unauthenticated client
    }
    if (!o.onExchange) return;
    const e = expand(octokit, options as unknown as HookOptions);
    o.onExchange({
      client: kind,
      method: e.method,
      route: String((options as unknown as HookOptions).url),
      path: e.path,
      query: e.query,
      status: response.status,
      ...(e.method !== "GET" ? { requestBody: e.body } : {}),
      responseHeaders: Object.fromEntries(
        Object.entries(response.headers as Record<string, unknown>)
          .filter(([k]) => KEEP_HEADERS.test(k))
          .map(([k, v]) => [k.toLowerCase(), String(v)]),
      ),
      responseBody: response.data,
    });
  });
  octokit.hook.error("request", async (error, options) => {
    counter.n += 1;
    const status = (error as { status?: unknown }).status;
    if (o.onExchange && typeof status === "number") {
      const e = expand(octokit, options as unknown as HookOptions);
      o.onExchange({
        client: kind,
        method: e.method,
        route: String((options as unknown as HookOptions).url),
        path: e.path,
        query: e.query,
        status,
        ...(e.method !== "GET" ? { requestBody: e.body } : {}),
        responseHeaders: {},
        responseBody: { message: "error" },
      });
    }
    throw error;
  });
  return installRateLimit(octokit, {
    sleep: o.sleep,
    now: o.now,
    minRemaining: 100,
    maxWaitMs: 15 * 60_000,
    maxRequests: o.maxRequests,
  });
}

export function buildClients(o: ClientOptions): Clients {
  const baseUrl = o.config.githubApiUrl;
  const counter = { n: 0 };
  o.secrets.add(o.actorToken);
  o.secrets.add(o.outsiderToken);
  const fetchOpt = o.fetch ? { fetch: o.fetch } : {};

  const actor = forToken(o.actorToken, { baseUrl, ...fetchOpt });
  instrument(actor, "actor", o, counter);

  let outsider: GitHubClient | undefined;
  if (o.outsiderToken) {
    outsider = forToken(o.outsiderToken, { baseUrl, ...fetchOpt });
    instrument(outsider, "outsider", o, counter);
  }

  const factory: GitHubClientFactory = createGitHubClientFactory({
    appId: o.config.githubAppId,
    privateKey: o.config.githubAppPrivateKey,
    baseUrl,
    ...fetchOpt,
  });
  const app = factory.asApp();
  instrument(app, "app", o, counter);

  let probe: Promise<GitHubClient> | undefined;
  return {
    actor,
    outsider,
    app,
    probe(installationId) {
      probe ??= factory.forInstallation(installationId).then((c) => {
        instrument(c, "probe", o, counter);
        return c;
      });
      return probe;
    },
    requests: () => counter.n,
  };
}
