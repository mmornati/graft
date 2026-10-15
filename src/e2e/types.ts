/** Shared types of the e2e runner: injected dependencies, options and the run context. */
import type { Config } from "../config/index.js";
import type { Db } from "../db/client.js";
import type { GitHubClient } from "../github/client-factory.js";
import type { Clients } from "./clients.js";
import type { SandboxConfig, SandboxEntry } from "./guard.js";
import type { SecretRegistry } from "./secrets.js";
import type { Clock } from "./waiters.js";

export type LlmFlag = "auto" | "live" | "none";
export type LlmMode = "live" | "none";

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Copies the source repository's files (no history) into the sandbox with one commit (D2). */
export interface GitPusher {
  /**
   * Clones `source` (depth 1, anonymous), removes `drop` paths, overlays `files`, commits once on
   * `main` and pushes to `sandbox`. Throws an error named `LfsRefused` when the source uses LFS.
   */
  copyAndPush(o: {
    sandbox: string;
    source: string;
    token: string;
    files: Map<string, string>;
    drop: string[];
    message: string;
    /** Builds the marker once the source commit is known. */
    marker(sourceCommit: string): string;
  }): Promise<{ sourceCommit: string }>;
}

export interface E2eDeps {
  loadConfig(): Config;
  /** Process environment (actor and outsider tokens live here, never in `.env`). */
  env: Record<string, string | undefined>;
  /** The raw `.env` file as key/value pairs, or null when there is none. */
  readDotEnv(): Record<string, string> | null;
  fetch?: typeof fetch;
  openReadOnlyDb(url: string): Db;
  ops(
    argv: string[],
    o?: {
      baselineToken?: string;
      /** The default implementation records every request of the token client here. */
      requestLog?: { method: string; url: string }[];
    },
  ): Promise<{ code: number; out: string; err: string }>;
  readyz(): Promise<boolean>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  prompt(question: string): Promise<string>;
  /** `git`, `gh` and vitest only; argv arrays, never a shell. */
  spawn(
    command: string,
    args: string[],
    o?: { env?: Record<string, string>; cwd?: string },
  ): Promise<SpawnResult>;
  outDir: string;
  isTty: boolean;
  /** Repository root (where `e2e/`, `docs/` and `package.json` live). */
  rootDir: string;
  gitPusher?: GitPusher;
  /** Gap between two non-GET requests of one token. Default 1000. */
  mutationSpacingMs?: number;
  /** True when a process with this pid is alive (the run lock). Default: `process.kill(pid, 0)`. */
  isAlive?(pid: number): boolean;
  pid?: number;
  /** Random bytes (run id, sentinels). */
  random?(n: number): Uint8Array;
  /** Lets the offline mode report as such. */
  target?: "github" | "offline";
}

export interface IoLike {
  out(s: string): void;
  err(s: string): void;
}

export interface RunOptions {
  sandbox?: string | undefined;
  scenarios: string[];
  runId?: string | undefined;
  dryRun: boolean;
  interactive: boolean;
  llm: LlmFlag;
  maxCostUsd: number;
  lenientModel: boolean;
  waitCron: boolean;
  withSourceBaseline: boolean;
  serverLog?: string | undefined;
  workerLog?: string | undefined;
  capture: boolean;
  timeoutScale: number;
  confirm?: string | undefined;
  json: boolean;
  onlyOffline: boolean;
}

export interface Actor {
  login: string;
  id: number;
}

export interface RunCtx {
  deps: E2eDeps;
  io: IoLike;
  secrets: SecretRegistry;
  config: Config;
  sandboxConfig: SandboxConfig;
  sandbox: SandboxEntry;
  owner: string;
  repo: string;
  runId: string;
  opts: RunOptions;
  clients: Clients;
  db: Db;
  actor: Actor;
  /** The actor's token (only `baseline --auth token` needs it; never printed or stored). */
  actorToken: string;
  outsider: Actor | undefined;
  installationId: number;
  repositoryId: number;
  clock: Clock;
  runDir: string;
  /** Mutable: decided by s01 in `auto` mode. */
  llmMode: LlmMode | undefined;
  /** Node ids of this run's sandbox PRs (the GraphQL guard). */
  pullRequestIds: Set<string>;
  forkVerified: boolean;
  /** Fixture files an edit may name (`graft.yaml`, `graft.s05.yaml`, ...). */
  fixtures: Map<string, string>;
  /** The actor's client; a shortcut. */
  actorOctokit: GitHubClient;
}
