import type { JobDefinition } from "../queue/job.js";
import { createGithubWebhookJob, type GithubWebhookData } from "./dispatch-job.js";
import type { WebhookHandler } from "./handler.js";

export interface Registry {
  /** Handlers for `event` and `event.action`, in registration order, without duplicates. */
  handlersFor(event: string, action: string | undefined): WebhookHandler[];
  isHandled(event: string, action: string | undefined): boolean;
  /** Includes github.webhook. */
  jobs: readonly JobDefinition<unknown>[];
  /** The `github.webhook` job (also present in `jobs`); the receiver sends this one. */
  webhookJob: JobDefinition<GithubWebhookData>;
}

export function createRegistry(o: {
  webhookHandlers: readonly WebhookHandler[];
  jobs: readonly JobDefinition<unknown>[];
}): Registry {
  const handlerNames = new Set<string>();
  for (const h of o.webhookHandlers) {
    if (handlerNames.has(h.name)) throw new Error(`duplicate webhook handler name: ${h.name}`);
    handlerNames.add(h.name);
  }
  const webhookJob = createGithubWebhookJob({ handlersFor: (e, a) => handlersFor(e, a) });
  const jobs: JobDefinition<unknown>[] = [webhookJob as JobDefinition<unknown>];
  const jobNames = new Set<string>([webhookJob.name]);
  for (const j of o.jobs) {
    if (jobNames.has(j.name)) throw new Error(`duplicate job name: ${j.name}`);
    jobNames.add(j.name);
    jobs.push(j);
  }

  const handlersFor = (event: string, action: string | undefined): WebhookHandler[] => {
    const keys = new Set<string>([event]);
    if (action !== undefined) keys.add(`${event}.${action}`);
    return o.webhookHandlers.filter((h) => h.on.some((k) => keys.has(k)));
  };

  return {
    handlersFor,
    isHandled: (event, action) => handlersFor(event, action).length > 0,
    jobs,
    webhookJob,
  };
}
