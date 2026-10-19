import { applyCronSchedules } from "../app/crons.js";
import { buildAppRegistry } from "../app/registry.js";
import { type Config, ConfigError, loadConfig } from "../config/index.js";
import { systemClock } from "../core/clock.js";
import type { AppDeps } from "../core/context.js";
import { setGlobBackstopHook } from "../core/glob.js";
import { createLogger } from "../core/logger.js";
import { createSignals } from "../core/signals.js";
import { createDb } from "../db/client.js";
import { pendingMigrations } from "../db/migrator.js";
import { createGitHubClientFactory } from "../github/client-factory.js";
import { createLlmClient } from "../llm/index.js";
import { mutationGate } from "../modules/modes/index.js";
import { nonAsciiCodePoints } from "../policy/globs.js";
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
  setGlobBackstopHook((what) =>
    log.error(
      { what },
      "glob matching hit its wall-clock guard: the work budget should have bound it",
    ),
  );
  // T14: a non-ASCII glob is valid but easy to get wrong (lookalike letters); warn, never fail.
  config.intentSensitivePaths.forEach((g, index) => {
    const codePoints = nonAsciiCodePoints(g);
    if (codePoints.length > 0) {
      log.warn(
        { index: index + 1, codePoints },
        "GRAFT_INTENT_SENSITIVE_PATHS: glob has non-ASCII characters",
      );
    }
  });
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
  if (opts.supervise) {
    await applyCronSchedules(queue, config);
  }

  const github = createGitHubClientFactory({
    appId: config.githubAppId,
    privateKey: config.githubAppPrivateKey,
    baseUrl: config.githubApiUrl,
    // Phase 1 writes read the effective mode from the database at request time (D12).
    gate: mutationGate(db, config),
    onRefused: (e) =>
      log.error(
        { method: e.method, route: e.route, feature: e.feature, reason: e.refusal },
        "github write refused by the mutation guard",
      ),
  });

  const llm = createLlmClient(config, log);

  const signals = createSignals(registry.signalListeners);

  return { config, log, db, queue, github, llm, clock: systemClock, registry, signals };
}
