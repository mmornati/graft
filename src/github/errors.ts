import { PermanentJobError, sanitizeError } from "../queue/errors.js";

export type GitHubErrorClass = "not_found" | "rate_limited" | "forbidden" | "invalid" | "transient";

interface HttpErrorLike {
  status: number;
  message: string;
  response?: { headers?: Record<string, string | undefined> };
}

function isHttpError(err: unknown): err is HttpErrorLike {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { status?: unknown }).status === "number"
  );
}

/** Duck-typed on Octokit's RequestError: no dependency on @octokit/request-error. */
export function classifyGitHubError(err: unknown): GitHubErrorClass {
  if (!isHttpError(err)) return "transient";
  const { status } = err;
  if (status === 404 || status === 410) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 403) {
    const h = err.response?.headers ?? {};
    const get = (name: string) => {
      for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return v;
      return undefined;
    };
    if (
      get("x-ratelimit-remaining") === "0" ||
      get("retry-after") !== undefined ||
      /secondary rate limit/i.test(String(err.message))
    ) {
      return "rate_limited";
    }
    return "forbidden";
  }
  if (status === 401) return "forbidden";
  if (status === 422) return "invalid";
  return "transient";
}

/**
 * Permanent classes become PermanentJobError (the worker completes the job); everything else stays
 * retryable. Either way the result is a new error that holds metadata only (status, method, route
 * template, request id, a short message): never the original, whose request and response bodies
 * can hold model output. A PermanentJobError that is passed in is already ours and is sanitized.
 */
export function toJobError(err: unknown, what: string): Error {
  if (err instanceof PermanentJobError) return sanitizeError(err);
  const cls = classifyGitHubError(err);
  const safe = sanitizeError(err);
  const status = isHttpError(err) ? err.status : undefined;
  if (cls === "not_found" || cls === "forbidden" || cls === "invalid") {
    return new PermanentJobError(
      `GitHub ${what} failed (${cls}${status ? `, HTTP ${status}` : ""})`,
      cls,
      { cause: safe },
    );
  }
  return safe;
}
