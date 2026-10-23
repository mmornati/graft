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
export { computeProvenance, type McpReportState, mcpAgreement } from "./compute.js";
export { fetchPrCommits } from "./fetch.js";
export type { GraftField, ProvenanceWarning } from "./fields.js";
export { normalizeField } from "./fields.js";
export { PROVENANCE_CHECK_NAME, provenanceRefreshJob, type RefreshData } from "./job.js";
export { type ChangeProvenanceRow, getChangeProvenance, getMcpReport } from "./store.js";
