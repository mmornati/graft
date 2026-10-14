/**
 * Thrown by a job when retrying cannot help (deleted PR, lost permission, bad payload). The
 * worker logs it and completes the job instead of failing it.
 */
export class PermanentJobError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PermanentJobError";
  }
}

const MAX_MESSAGE = 200;

/**
 * An error stripped to metadata. Octokit and SDK errors carry the request (headers, body) and the
 * response (headers, data) as enumerable properties, and pino and pg-boss both serialize those.
 * For Graft that body can be a rendered card, i.e. model output (README §5: never logged, never
 * stored). Only these fields survive; there is no `cause` and no copy of the original stack text.
 */
export class SafeError extends Error {
  status?: number;
  method?: string;
  route?: string;
  requestId?: string;
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

function shortMessage(m: unknown): string {
  const text = typeof m === "string" ? m : "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_MESSAGE ? `${oneLine.slice(0, MAX_MESSAGE)}...` : oneLine;
}

/** Path only (no host, no query), with numeric ids and SHAs replaced: a route template. */
function routeTemplate(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  let path = url;
  try {
    path = new URL(url, "https://api.invalid").pathname;
  } catch {
    // keep the raw text, trimmed below
  }
  return path
    .split("/")
    .map((seg) => (/^[0-9a-f]{40}$/i.test(seg) ? ":sha" : /^\d+$/.test(seg) ? ":n" : seg))
    .join("/")
    .slice(0, 200);
}

function frames(err: unknown): string | undefined {
  const stack = err instanceof Error ? err.stack : undefined;
  if (!stack) return undefined;
  return stack
    .split("\n")
    .filter((l) => /^\s+at /.test(l))
    .join("\n");
}

/**
 * Never throws and never returns the input: the result is safe to log and to rethrow into
 * pg-boss. Kept: error name, a short single-line message, HTTP status, request method, route
 * template and GitHub's request id.
 */
export function sanitizeError(err: unknown): Error {
  if (err instanceof PermanentJobError) {
    const safe = new PermanentJobError(
      shortMessage(err.message),
      err.reason,
      err.cause === undefined ? undefined : { cause: sanitizeError(err.cause) },
    );
    const f = frames(err);
    safe.stack = `${safe.name}: ${safe.message}${f ? `\n${f}` : ""}`;
    return safe;
  }
  const rec = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
  const name = err instanceof Error && typeof err.name === "string" ? err.name : "Error";
  const safe = new SafeError(name.slice(0, 80), shortMessage(rec.message));
  if (typeof rec.status === "number") safe.status = rec.status;
  const request = rec.request as { method?: unknown; url?: unknown } | undefined;
  if (request && typeof request.method === "string") safe.method = request.method.slice(0, 10);
  if (request) safe.route = routeTemplate(request.url);
  const headers = (rec.response as { headers?: Record<string, unknown> } | undefined)?.headers;
  const rid = headers?.["x-github-request-id"];
  if (typeof rid === "string") safe.requestId = rid.slice(0, 80);
  const f = frames(err);
  safe.stack = `${safe.name}: ${safe.message}${f ? `\n${f}` : ""}`;
  return safe;
}
