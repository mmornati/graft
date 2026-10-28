import type { IncomingMessage, Server, ServerResponse } from "node:http";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import type { AppDeps } from "../core/context.js";
import type { Logger } from "../core/logger.js";
import { mcpRoutes } from "../modules/mcp/index.js";
import { sanitizeError } from "../queue/errors.js";
import { webhookReceiver } from "../webhooks/receiver.js";
import { healthRoutes } from "./health.js";

export type AppServer = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>;

export async function buildServer(deps: AppDeps): Promise<AppServer> {
  const production = deps.config.nodeEnv === "production";
  const app = Fastify({
    // Phase 1 step 7 (D6): only the operator's proxies may set the client address; never `true`.
    trustProxy: deps.config.trustProxy.length > 0 ? deps.config.trustProxy.join(",") : false,
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
      uninstall: async (installationId) => {
        await deps.github.asApp().request("DELETE /app/installations/{installation_id}", {
          installation_id: installationId,
        });
      },
    }),
  );
  // Phase 1 step 6 (D22): off means the route is not registered (the not-found handler answers).
  if (deps.config.mcp) {
    await app.register(
      mcpRoutes({
        db: deps.db,
        config: deps.config,
        github: deps.github,
        queue: deps.queue,
        clock: deps.clock,
        log: deps.log,
      }),
    );
  }
  return app;
}
