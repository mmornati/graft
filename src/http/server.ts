import type { IncomingMessage, Server, ServerResponse } from "node:http";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import type { AppDeps } from "../core/context.js";
import type { Logger } from "../core/logger.js";
import { sanitizeError } from "../queue/errors.js";
import { webhookReceiver } from "../webhooks/receiver.js";
import { healthRoutes } from "./health.js";

export type AppServer = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>;

export async function buildServer(deps: AppDeps): Promise<AppServer> {
  const production = deps.config.nodeEnv === "production";
  const app = Fastify({
    loggerInstance: deps.log,
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: "not found" });
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err: sanitizeError(err) }, "unhandled error");
    // No internals (messages or stacks) for server errors in production.
    const message = status >= 500 && production ? "internal error" : err.message;
    void reply.code(status).send({ error: message });
  });

  await app.register(healthRoutes({ db: deps.db, queue: deps.queue }));
  await app.register(
    webhookReceiver({
      db: deps.db,
      queue: deps.queue,
      registry: deps.registry,
      clock: deps.clock,
      config: deps.config,
      log: deps.log,
    }),
  );
  return app;
}
