import type { EmitterWebhookEvent, EmitterWebhookEventName } from "@octokit/webhooks";
import type { JobContext } from "../core/context.js";

export interface WebhookHandler<E extends EmitterWebhookEventName = EmitterWebhookEventName> {
  /** Unique, e.g. "installations.track". */
  name: string;
  /** "installation" or "installation.created" forms. */
  on: readonly E[];
  handle(event: EmitterWebhookEvent<E> & { deliveryId: string }, ctx: JobContext): Promise<void>;
}

export function defineWebhookHandler<E extends EmitterWebhookEventName>(
  h: WebhookHandler<E>,
): WebhookHandler {
  return h as unknown as WebhookHandler;
}
