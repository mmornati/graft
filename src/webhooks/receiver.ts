import { verify } from "@octokit/webhooks-methods";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Config } from "../config/index.js";
import type { Clock } from "../core/clock.js";
import type { Logger } from "../core/logger.js";
import type { Db } from "../db/client.js";
import type { JobQueue } from "../queue/queue.js";
import { recordDelivery } from "./deliveries.js";
import type { Registry } from "./registry.js";

export interface ReceiverDeps {
  db: Db;
  queue: JobQueue;
  registry: Registry;
  clock: Clock;
  config: Pick<Config, "githubWebhookSecret" | "webhookBodyLimitBytes">;
  log: Logger;
}

/** Matches the CHECK constraint on webhook_deliveries.delivery_id. */
const MAX_DELIVERY_ID_LENGTH = 100;

function header(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function numericId(v: unknown): number | undefined {
  const id = asRecord(v)?.id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

export const webhookReceiver =
  (deps: ReceiverDeps): FastifyPluginAsync =>
  async (app: FastifyInstance) => {
    // This route has its own parser that keeps the raw string (needed for the HMAC); the global
    // JSON parser is never used here. Any other content type gets Fastify's 415.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      done(null, body);
    });

    app.post(
      "/webhooks/github",
      { bodyLimit: deps.config.webhookBodyLimitBytes },
      async (req, reply) => {
        const event = header(req.headers["x-github-event"]);
        const deliveryId = header(req.headers["x-github-delivery"]);
        const signature = header(req.headers["x-hub-signature-256"]);
        const log = deps.log.child({ deliveryId, event });

        if (!event || !deliveryId || !signature) {
          log.warn({ outcome: "bad_request" }, "webhook missing required header");
          return reply.code(400).send({ error: "missing required header" });
        }

        if (deliveryId.length > MAX_DELIVERY_ID_LENGTH) {
          log.warn({ outcome: "bad_request" }, "webhook delivery id too long");
          return reply.code(400).send({ error: "invalid delivery id" });
        }

        const rawBody = req.body as string;
        if (rawBody.length === 0) {
          log.warn({ outcome: "bad_request" }, "webhook body is empty");
          return reply.code(400).send({ error: "empty body" });
        }
        let valid = false;
        try {
          valid = await verify(deps.config.githubWebhookSecret, rawBody, signature);
        } catch {
          valid = false;
        }
        if (!valid) {
          log.warn({ outcome: "invalid_signature" }, "webhook signature rejected");
          return reply.code(401).send({ error: "invalid signature" });
        }

        let payload: Record<string, unknown> | undefined;
        try {
          payload = asRecord(JSON.parse(rawBody));
        } catch {
          payload = undefined;
        }
        if (!payload) {
          log.warn({ outcome: "invalid_json" }, "webhook body is not a JSON object");
          return reply.code(400).send({ error: "invalid JSON" });
        }

        const action = typeof payload.action === "string" ? payload.action : undefined;
        const installationId = numericId(payload.installation);
        const repositoryId = numericId(payload.repository);

        try {
          const outcome = await recordDelivery(deps, {
            deliveryId,
            event,
            action,
            installationId,
            repositoryId,
            payload,
          });
          log.info({ action, installationId, outcome }, "webhook processed");
          if (outcome === "duplicate") return reply.code(200).send({ status: "duplicate" });
          return reply.code(202).send({ status: outcome });
        } catch (err) {
          log.error({ err, action, installationId, outcome: "error" }, "webhook processing failed");
          return reply.code(500).send({ error: "internal error" });
        }
      },
    );
  };
