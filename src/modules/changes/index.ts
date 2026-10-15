import type { JobDefinition } from "../../queue/job.js";
import type { WebhookHandler } from "../../webhooks/handler.js";

export const webhookHandlers: WebhookHandler[] = [];
export const jobs: JobDefinition<unknown>[] = [];

export {
  type Change,
  findChangeByHead,
  getChange,
  getChangeByNumber,
  type LivePull,
  upsertChangeFromPull,
} from "./store.js";
