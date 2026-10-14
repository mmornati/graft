import type { JobDefinition } from "../../queue/job.js";
import type { WebhookHandler } from "../../webhooks/handler.js";
import { trackInstallations } from "./handlers.js";

export const webhookHandlers: WebhookHandler[] = [trackInstallations];
export const jobs: JobDefinition<unknown>[] = [];

export { getActiveRepository, listActiveRepositories } from "./store.js";
