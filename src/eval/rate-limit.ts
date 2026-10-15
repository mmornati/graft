/**
 * GitHub rate-limit handling for the export (E15, T7): a request wrapper with injected time.
 * No new dependency; `@octokit/plugin-throttling` is not installed.
 */
import type { GitHubClient } from "../github/client-factory.js";
import { classifyGitHubError } from "../github/errors.js";

export class EvalAbort extends Error {
  constructor(readonly code: "rate_limit_wait" | "max_requests") {
    super(
      code === "rate_limit_wait"
        ? "aborted: the rate-limit wait is longer than --max-wait"
        : "aborted: --max-requests reached",
    );
    this.name = "EvalAbort";
  }
}

export interface RateLimitOptions {
  sleep: (ms: number) => Promise<void>;
  /** Epoch milliseconds. */
  now: () => number;
  minRemaining: number;
  maxWaitMs: number;
  maxRequests: number;
  onWait?: (ms: number) => void;
}

const MAX_RETRIES = 3;
const DEFAULT_SECONDARY_WAIT_MS = 60_000;

type Headers = Record<string, string | number | undefined> | undefined;

function header(h: Headers, name: string): string | undefined {
  if (!h) return undefined;
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === name && v !== undefined) return String(v);
  }
  return undefined;
}

export interface RateLimitStats {
  requests: () => number;
  waits: () => { count: number; totalMs: number };
}

export function installRateLimit(octokit: GitHubClient, o: RateLimitOptions): RateLimitStats {
  let requests = 0;
  let waitCount = 0;
  let waitTotal = 0;

  const wait = async (ms: number): Promise<void> => {
    if (ms > o.maxWaitMs) throw new EvalAbort("rate_limit_wait");
    waitCount += 1;
    waitTotal += ms;
    o.onWait?.(ms);
    await o.sleep(ms);
  };

  const untilReset = (h: Headers): number | null => {
    const reset = Number(header(h, "x-ratelimit-reset"));
    return Number.isFinite(reset) && reset > 0 ? reset * 1000 + 1000 - o.now() : null;
  };

  octokit.hook.wrap("request", async (request, options) => {
    let retries = 0;
    for (;;) {
      requests += 1;
      if (requests > o.maxRequests) throw new EvalAbort("max_requests");
      try {
        const res = await request(options);
        const remaining = Number(header(res.headers as Headers, "x-ratelimit-remaining"));
        if (Number.isFinite(remaining) && remaining <= o.minRemaining) {
          const ms = untilReset(res.headers as Headers);
          if (ms !== null && ms > 0) await wait(ms);
        }
        return res;
      } catch (err) {
        if (err instanceof EvalAbort) throw err;
        if (classifyGitHubError(err) !== "rate_limited" || retries >= MAX_RETRIES) throw err;
        const h = (err as { response?: { headers?: Headers } }).response?.headers;
        const retryAfter = Number(header(h, "retry-after"));
        const ms = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : (untilReset(h) ?? DEFAULT_SECONDARY_WAIT_MS);
        retries += 1;
        await wait(Math.max(ms, 0));
      }
    }
  });

  return {
    requests: () => requests,
    waits: () => ({ count: waitCount, totalMs: waitTotal }),
  };
}
