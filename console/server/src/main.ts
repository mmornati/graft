import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createReadOnlyDb, ReadOnlyError, verifyReadOnly } from "./db.js";
import { loadWebAssets } from "./static.js";

declare const __CONSOLE_VERSION__: string;
const VERSION = typeof __CONSOLE_VERSION__ === "string" ? __CONSOLE_VERSION__ : "dev";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({
    level: config.logLevel,
    redact: {
      paths: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
      censor: "[redacted]",
    },
  });
  const db = createReadOnlyDb(config.databaseUrl, {
    statementTimeoutMs: config.statementTimeoutMs,
  });
  const role = await verifyReadOnly(db, config.requireReadOnlyRole);
  log.info(
    {
      role: role.role,
      roleReadOnly: role.roleReadOnly,
      pgboss: role.pgboss,
      auth: config.auth.mode,
    },
    "connected read-only",
  );
  if (!role.roleReadOnly) log.warn("the database role can write; only the session is read-only");
  if (config.auth.mode === "none") log.warn("CONSOLE_AUTH=none: no sign-in, loopback only");

  const web = loadWebAssets(fileURLToPath(new URL("./web", import.meta.url)));
  const app = await buildApp({ config, db, log, web, version: VERSION, pgboss: role.pgboss });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    try {
      await app.close();
      await db.destroy();
      process.exit(0);
    } catch (err) {
      log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError || err instanceof ReadOnlyError) {
    console.error(`graft-console: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
