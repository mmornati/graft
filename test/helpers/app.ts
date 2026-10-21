import { buildAppRegistry } from "../../src/app/registry.js";
import type { AppDeps, JobContext } from "../../src/core/context.js";
import type { Logger } from "../../src/core/logger.js";
import { createSignals } from "../../src/core/signals.js";
import type { Db } from "../../src/db/client.js";
import {
  createGitHubClientFactory,
  type GitHubClientFactory,
} from "../../src/github/client-factory.js";
import {
  type MutationGate,
  type MutationRefusedError,
  refuseAllGate,
} from "../../src/github/mutation-guard.js";
import type { buildServer } from "../../src/http/server.js";
import { forbiddenLlm } from "../../src/llm/fake.js";
import type { LlmClient } from "../../src/llm/types.js";
import { createPgBossQueue, type PgBossJobQueue } from "../../src/queue/queue.js";
import { fixedClock, TEST_PRIVATE_KEY, TEST_WEBHOOK_SECRET, testConfig } from "./config.js";
import { testDb } from "./db.js";
import { loadFixture } from "./fixtures.js";
import { sign } from "./sign.js";
import { silentLog } from "./stubs.js";

/** A GitHub factory that fails the test if anything in step 1 calls the GitHub API. */
/** `calls` counts both kinds; `installationCalls` only installation-token clients. */
export function forbiddenGitHub(): GitHubClientFactory & {
  calls: number;
  installationCalls: number;
} {
  const f = {
    calls: 0,
    installationCalls: 0,
    forInstallation: async () => {
      f.calls++;
      f.installationCalls++;
      throw new Error("GitHub API must not be called");
    },
    asApp: () => {
      f.calls++;
      throw new Error("GitHub API must not be called");
    },
  };
  return f as unknown as GitHubClientFactory & { calls: number; installationCalls: number };
}

export interface TestApp {
  deps: AppDeps & { queue: PgBossJobQueue };
  db: Db;
  close(): Promise<void>;
}

/** A real client factory whose HTTP goes to the in-memory fake GitHub API. */
export function fakeGitHubFactory(
  api: { fetch: typeof fetch },
  gate: MutationGate = refuseAllGate,
  onRefused?: (e: MutationRefusedError) => void,
): GitHubClientFactory {
  return createGitHubClientFactory({
    appId: 12345,
    privateKey: TEST_PRIVATE_KEY,
    baseUrl: "https://api.github.com",
    gate,
    ...(onRefused ? { onRefused } : {}),
    fetch: api.fetch,
  });
}

export async function createTestApp(
  opts: {
    supervise?: boolean;
    github?: GitHubClientFactory;
    log?: Logger;
    config?: Record<string, string>;
    llm?: LlmClient;
    clock?: AppDeps["clock"];
  } = {},
): Promise<TestApp> {
  const config = testConfig(opts.config);
  const log = opts.log ?? silentLog;
  const db = testDb();
  const registry = buildAppRegistry();
  const queue = createPgBossQueue({
    connectionString: config.databaseUrl,
    schema: config.pgbossSchema,
    registry,
    log,
    supervise: opts.supervise ?? false,
  });
  await queue.start();
  const deps = {
    config,
    log,
    db,
    queue,
    registry,
    clock: opts.clock ?? fixedClock,
    github: opts.github ?? forbiddenGitHub(),
    llm: opts.llm ?? forbiddenLlm(),
    signals: createSignals(registry.signalListeners),
  };
  return {
    deps,
    db,
    async close() {
      await queue.stop();
      await db.destroy();
    },
  };
}

export function jobContext(app: TestApp): JobContext {
  const { registry: _registry, ...ctx } = app.deps;
  return ctx;
}

export async function postFixture(
  app: Awaited<ReturnType<typeof buildServer>>,
  fixtureName: string,
  deliveryId: string,
) {
  const { event, body } = loadFixture(fixtureName);
  return postRaw(app, event, body, deliveryId);
}

export function postRaw(
  app: Awaited<ReturnType<typeof buildServer>>,
  event: string,
  body: string,
  deliveryId: string,
) {
  return app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": sign(body, TEST_WEBHOOK_SECRET),
    },
    payload: body,
  });
}
