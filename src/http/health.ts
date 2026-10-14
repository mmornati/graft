import { readFileSync } from "node:fs";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import type { Db } from "../db/client.js";
import type { JobQueue } from "../queue/queue.js";

const CHECK_TIMEOUT_MS = 2000;

function readVersion(): string {
  try {
    const url = new URL("../../package.json", import.meta.url);
    return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

const VERSION = readVersion();

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const healthRoutes =
  (deps: { db: Db; queue: JobQueue; timeoutMs?: number }): FastifyPluginAsync =>
  async (app) => {
    const ms = deps.timeoutMs ?? CHECK_TIMEOUT_MS;

    app.get("/healthz", async () => ({ status: "ok", version: VERSION }));

    app.get("/readyz", async (_req, reply) => {
      const dbCheck = withTimeout(sql`select 1`.execute(deps.db), ms).then(
        () => "ok" as const,
        () => "error" as const,
      );
      const queueCheck = withTimeout(deps.queue.ping(), ms).then(
        (ok) => (ok ? ("ok" as const) : ("error" as const)),
        () => "error" as const,
      );
      const [dbState, queueState] = await Promise.all([dbCheck, queueCheck]);
      const ready = dbState === "ok" && queueState === "ok";
      return reply
        .code(ready ? 200 : 503)
        .send({ status: ready ? "ready" : "unavailable", db: dbState, queue: queueState });
    });
  };
