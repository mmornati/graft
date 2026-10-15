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
}

export interface AppDeps extends JobContext {
  registry: Registry;
}
