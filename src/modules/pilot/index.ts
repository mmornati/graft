import type { SignalListener } from "../../core/signals.js";
import type { JobDefinition } from "../../queue/job.js";
import type { WebhookHandler } from "../../webhooks/handler.js";
import { incidentDetectJob, scheduleIncidentDetection } from "./incidents.js";
import { onChangeSignal, reviewersSyncJob, scheduleReviewerSync } from "./reviewers.js";
import { metricsRollupJob } from "./rollup.js";

export const webhookHandlers: WebhookHandler[] = [scheduleReviewerSync, scheduleIncidentDetection];
export const jobs: JobDefinition<unknown>[] = [
  reviewersSyncJob as JobDefinition<unknown>,
  incidentDetectJob as JobDefinition<unknown>,
  metricsRollupJob as JobDefinition<unknown>,
];
export const signalListeners: SignalListener[] = [onChangeSignal];

export {
  type DetectData,
  detectIncident,
  hasLabel,
  incidentDetectJob,
  parseCulprits,
} from "./incidents.js";
export { type SyncData, type SyncOutcome, syncReviewers } from "./reviewers.js";
export {
  type CountKey,
  computeDays,
  emptyCounts,
  type MetricsCounts,
  metricsCountsSchema,
  metricsRollupJob,
  ROLLUP_RETENTION_DAYS,
  ROLLUP_VERSION,
  rollupRange,
  runRollup,
} from "./rollup.js";
export {
  addReviewers,
  findUnlinkedIncident,
  type IncidentRow,
  insertIncident,
  listIncidents,
} from "./store.js";
