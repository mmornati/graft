import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { z } from "zod";
import { defineJob, type JobDefinition } from "../queue/job.js";
import type { WebhookHandler } from "./handler.js";

export const GITHUB_WEBHOOK_JOB = "github.webhook";

export const githubWebhookSchema = z.object({
  deliveryId: z.string().min(1),
  event: z.string().min(1),
  action: z.string().optional(),
  installationId: z.number().int().optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type GithubWebhookData = z.infer<typeof githubWebhookSchema>;

/**
 * Builds the `github.webhook` JobDefinition. It is a factory because the job needs the registry's
 * handler lookup, and the registry in turn lists this job (createRegistry ties the knot).
 */
export function createGithubWebhookJob(registry: {
  handlersFor(event: string, action: string | undefined): WebhookHandler[];
}): JobDefinition<GithubWebhookData> {
  return defineJob<GithubWebhookData>({
    name: GITHUB_WEBHOOK_JOB,
    schema: githubWebhookSchema,
    async handle(data, ctx) {
      const handlers = registry.handlersFor(data.event, data.action);
      if (handlers.length === 0) {
        ctx.log.warn(
          { deliveryId: data.deliveryId, event: data.event, action: data.action },
          "no webhook handler matches; completing",
        );
        return;
      }
      for (const handler of handlers) {
        const log = ctx.log.child({ deliveryId: data.deliveryId, handler: handler.name });
        const event = {
          id: data.deliveryId,
          deliveryId: data.deliveryId,
          name: data.event,
          payload: data.payload,
        } as unknown as EmitterWebhookEvent & { deliveryId: string };
        await handler.handle(event, { ...ctx, log });
      }
    },
  });
}
