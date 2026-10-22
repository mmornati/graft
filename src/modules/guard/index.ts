/**
 * The post-merge guard, detection and culprit (Phase 1 step 4). Report mode stays inert: the only
 * GitHub write is one comment per `culprit_found` event on the culprit PR, through the default
 * installation client. Nothing here builds a `guard` feature client (step 5).
 */
import type { JobDefinition } from "../../queue/job.js";
import type { WebhookHandler } from "../../webhooks/handler.js";
import { guardCheckRun, guardCheckSuite, guardPush, guardStatus } from "./handlers.js";
import { guardConfirmJob, guardObserveJob } from "./observe.js";
import { guardPruneJob } from "./prune.js";
import { guardTrackJob } from "./track.js";

export const webhookHandlers: WebhookHandler[] = [
  guardPush,
  guardCheckRun,
  guardCheckSuite,
  guardStatus,
];
export const jobs: JobDefinition<unknown>[] = [
  guardTrackJob as JobDefinition<unknown>,
  guardObserveJob as JobDefinition<unknown>,
  guardConfirmJob as JobDefinition<unknown>,
  guardPruneJob as JobDefinition<unknown>,
];
/** Registered by `src/app/crons.ts`. */
export const crons = { prune: guardPruneJob } as const;

export {
  GUARD_STATUSES,
  guardList,
  guardListJson,
  type ListedEvent,
  renderGuardList,
} from "./cli.js";
export {
  githubWebBase,
  guardMarker,
  isOurGuardComment,
  type PublishOutcome,
  publishGuardComment,
  renderGuardComment,
  safeHtmlUrl,
} from "./comment.js";
export {
  classifyStored,
  confirmEvent,
  guardConfirmJob,
  guardObserveJob,
  observeCommit,
  scheduleObserve,
} from "./observe.js";
export { guardPruneJob } from "./prune.js";
export { type ConfirmData, type ObserveData, observeKey } from "./schemas.js";
export { pruneOlderThan } from "./store.js";
export { guardTrackJob, type TrackData, trackDefaultBranch } from "./track.js";
