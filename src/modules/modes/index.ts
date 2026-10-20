import type { JobDefinition } from "../../queue/job.js";
import type { WebhookHandler } from "../../webhooks/handler.js";
import { modesApplyJob, modesCeilingFanoutJob } from "./jobs.js";
import { refreshAllPermissionsJob, refreshPermissionsJob } from "./permissions.js";

export const webhookHandlers: WebhookHandler[] = [];
export const jobs: JobDefinition<unknown>[] = [
  modesApplyJob as JobDefinition<unknown>,
  modesCeilingFanoutJob as JobDefinition<unknown>,
  refreshPermissionsJob as JobDefinition<unknown>,
  refreshAllPermissionsJob as JobDefinition<unknown>,
];

export { CEILING_STATE_KEY, publishModeCeiling } from "./ceiling.js";
export { getEffectiveModes, modesOf, mutationGate } from "./effective.js";
export {
  applyModeChanges,
  type CeilingFanoutData,
  fanoutCeilingChange,
  modesApplyJob,
  modesCeilingFanoutJob,
} from "./jobs.js";
export {
  type RefreshData,
  refreshAllPermissionsJob,
  refreshPermissions,
  refreshPermissionsJob,
  sanitizePermissions,
} from "./permissions.js";
export {
  casServiceState,
  claimUnappliedModeChanges,
  countUnapplied,
  findActiveRepositoryByName,
  getRepositoryModeRow,
  getServiceState,
  insertModeChanges,
  listModeChanges,
  listRepositoryModeRows,
  markApplied,
  type NewModeChange,
  type RepositoryModeRow,
} from "./store.js";
