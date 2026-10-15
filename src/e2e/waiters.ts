/**
 * Waiting (D10): poll with exponential backoff until a condition holds or the timeout passes.
 * The clock and sleep are injected; nothing here uses a real timer.
 */
import { classifyGitHubError } from "../github/errors.js";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class WaitTimeout extends Error {
  constructor(
    readonly waitName: string,
    readonly lastObservation: unknown,
  ) {
    super(`timed out waiting for ${waitName}`);
    this.name = "WaitTimeout";
  }
}

const NETWORK_CODES = /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_.*)$/;

/** HTTP 5xx and 429 or rate-limit 403, and plain network failures; never a 404 or a bug. */
export function isRetryable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; code?: unknown; cause?: { code?: unknown } };
  if (typeof e.status === "number") {
    const cls = classifyGitHubError(err);
    return cls === "transient" || cls === "rate_limited";
  }
  const code = typeof e.code === "string" ? e.code : e.cause?.code;
  return typeof code === "string" && NETWORK_CODES.test(code);
}

export interface WaitOptions {
  name: string;
  timeoutMs: number;
  initialMs?: number;
  factor?: number;
  maxMs?: number;
}

/** Default timeouts (T8), in milliseconds. */
export const TIMEOUTS = {
  delivery: 90_000,
  provenance: 120_000,
  cardLive: 600_000,
  cardNone: 120_000,
  policyFinal: 300_000,
  reeval: 300_000,
  redelivery: 120_000,
  stability: 60_000,
  invitation: 600_000,
  cron: 16 * 60_000,
} as const;

/**
 * Returns the probe's first truthy value. A probe error classified `transient` or `rate_limited`
 * is retried; any other error propagates. On timeout, throws `WaitTimeout` with the last
 * observation (the last retried error's description when the probe never returned).
 */
export async function waitUntil<T>(
  probe: () => Promise<T | undefined | null | false | 0 | "">,
  o: WaitOptions,
  clock: Clock,
): Promise<T> {
  const initial = o.initialMs ?? 2000;
  const factor = o.factor ?? 1.5;
  const max = o.maxMs ?? 15_000;
  const deadline = clock.now() + o.timeoutMs;
  let delay = initial;
  let last: unknown;
  for (;;) {
    try {
      const v = await probe();
      last = v;
      if (v) return v as T;
    } catch (err) {
      if (!isRetryable(err)) throw err;
      last = `retryable error (${classifyGitHubError(err)})`;
    }
    const left = deadline - clock.now();
    if (left <= 0) throw new WaitTimeout(o.name, last);
    await clock.sleep(Math.min(delay, left));
    delay = Math.min(delay * factor, max);
  }
}

export const scaled = (ms: number, scale: number): number => Math.round(ms * scale);
