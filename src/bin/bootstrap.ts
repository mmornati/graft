import { buildAppRegistry } from "../app/registry.js";
import { type Config, ConfigError, loadConfig } from "../config/index.js";
import { systemClock } from "../core/clock.js";
import type { AppDeps } from "../core/context.js";
import { createLogger } from "../core/logger.js";
import { createDb } from "../db/client.js";
import { pendingMigrations } from "../db/migrator.js";
import { createGitHubClientFactory } from "../github/client-factory.js";
import { createPgBossQueue, type PgBossJobQueue } from "../queue/queue.js";
import { loadDotEnv } from "./env.js";

export interface Bootstrapped extends AppDeps {
  queue: PgBossJobQueue;
}

/** Shared wiring for the server and worker processes. Exits 1 when config/schema is wrong. */
export async function bootstrap(opts: { supervise: boolean }): Promise<Bootstrapped> {
  loadDotEnv();
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const log = createLogger(config);
  const db = createDb(config.databaseUrl);

  const pending = await pendingMigrations(db);
  if (pending.length > 0) {
    log.fatal({ pending }, "database schema is behind: run pnpm db:migrate");
    console.error("run pnpm db:migrate");
    await db.destroy();
    process.exit(1);
  }

  const registry = buildAppRegistry();
  const queue = createPgBossQueue({
    connectionString: config.databaseUrl,
    schema: config.pgbossSchema,
    registry,
    log,
    supervise: opts.supervise,
  });
  await queue.start();

  const github = createGitHubClientFactory({
    appId: config.githubAppId,
    privateKey: config.githubAppPrivateKey,
    baseUrl: config.githubApiUrl,
  });

  return { config, log, db, queue, github, clock: systemClock, registry };
}
