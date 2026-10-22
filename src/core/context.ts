import type { Config } from "../config/index.js";
import type { Db } from "../db/client.js";
import type { GitHubClientFactory } from "../github/client-factory.js";
import type { LlmClient } from "../llm/types.js";
import type { JobQueue } from "../queue/queue.js";
import type { Registry } from "../webhooks/registry.js";
import type { Clock } from "./clock.js";
import type { Logger } from "./logger.js";
import type { Signals } from "./signals.js";

export interface JobContext {
  db: Db;
  queue: JobQueue;
  github: GitHubClientFactory;
  log: Logger;
  clock: Clock;
  config: Config;
  llm: LlmClient;
  signals: Signals;
  /**
   * The attempt the worker is running: pg-boss's `retryCount` (0 on the first run) and the job's
   * own `retryLimit` (copied from the queue when the job was inserted, so a later change to the
   * definition does not apply to it). Absent outside the worker (direct calls, tests): treat as the
   * last one.
   */
  attempt?: { retryCount: number; retryLimit: number };
}

/** True when a retryable failure of this run will be tried again by the queue. */
export function canRetry(ctx: Pick<JobContext, "attempt">): boolean {
  return ctx.attempt !== undefined && ctx.attempt.retryCount < ctx.attempt.retryLimit;
}

export interface AppDeps extends JobContext {
  registry: Registry;
}
