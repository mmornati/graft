import type { JobDefinition } from "../../queue/job.js";
import type { WebhookHandler } from "../../webhooks/handler.js";
import { rerequestProvenance, scheduleProvenance } from "./handlers.js";
import { provenanceRefreshJob } from "./job.js";

export const webhookHandlers: WebhookHandler[] = [scheduleProvenance, rerequestProvenance];
export const jobs: JobDefinition<unknown>[] = [provenanceRefreshJob as JobDefinition<unknown>];

export type {
  AuthorKindReason,
  ProvenanceInput,
  ProvenanceResult,
  ResolvedField,
} from "./compute.js";
export type { GraftField, ProvenanceWarning } from "./fields.js";
