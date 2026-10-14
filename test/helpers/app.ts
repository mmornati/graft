import { buildAppRegistry } from "../../src/app/registry.js";
import type { AppDeps, JobContext } from "../../src/core/context.js";
import type { Db } from "../../src/db/client.js";
import type { GitHubClientFactory } from "../../src/github/client-factory.js";
import type { buildServer } from "../../src/http/server.js";
import { createPgBossQueue, type PgBossJobQueue } from "../../src/queue/queue.js";
import { fixedClock, TEST_WEBHOOK_SECRET, testConfig } from "./config.js";
import { testDb } from "./db.js";
import { loadFixture } from "./fixtures.js";
import { sign } from "./sign.js";
import { silentLog } from "./stubs.js";

/** A GitHub factory that fails the test if anything in step 1 calls the GitHub API. */
export function forbiddenGitHub(): GitHubClientFactory & { calls: number } {
  const f = {
    calls: 0,
    forInstallation: async () => {
      f.calls++;
      throw new Error("GitHub API must not be called");
    },
    asApp: () => {
      f.calls++;
      throw new Error("GitHub API must not be called");
    },
  };
  return f as unknown as GitHubClientFactory & { calls: number };
}

export interface TestApp {
  deps: AppDeps & { queue: PgBossJobQueue };
  db: Db;
  close(): Promise<void>;
}

export async function createTestApp(opts: { supervise?: boolean } = {}): Promise<TestApp> {
  const config = testConfig();
  const db = testDb();
  const registry = buildAppRegistry();
  const queue = createPgBossQueue({
    connectionString: config.databaseUrl,
    schema: config.pgbossSchema,
    registry,
    log: silentLog,
    supervise: opts.supervise ?? false,
  });
  await queue.start();
  const deps = {
    config,
    log: silentLog,
    db,
    queue,
    registry,
    clock: fixedClock,
    github: forbiddenGitHub(),
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
