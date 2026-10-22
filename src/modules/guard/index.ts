/**
 * The post-merge guard: detection and culprit (Phase 1 step 4), revert pull requests (step 5).
 * Report mode stays inert: the only GitHub write is one comment per event with a culprit, through
 * the default installation client. The revert's writes go through the `guard` feature client,
 * made only by `guard.revert` in enforce mode (`revert.ts`).
 */
import type { JobDefinition } from "../../queue/job.js";
import type { WebhookHandler } from "../../webhooks/handler.js";
import { guardCheckRun, guardCheckSuite, guardPush, guardStatus } from "./handlers.js";
import { guardConfirmJob, guardObserveJob } from "./observe.js";
import { guardPruneJob } from "./prune.js";
import { guardRevertJob } from "./revert.js";
import { guardPullRequestClosed, guardRevertClosedJob } from "./revert-closed.js";
import { guardTrackJob } from "./track.js";

export const webhookHandlers: WebhookHandler[] = [
  guardPush,
  guardCheckRun,
  guardCheckSuite,
  guardStatus,
  guardPullRequestClosed,
];
export const jobs: JobDefinition<unknown>[] = [
  guardTrackJob as JobDefinition<unknown>,
  guardObserveJob as JobDefinition<unknown>,
  guardConfirmJob as JobDefinition<unknown>,
  guardPruneJob as JobDefinition<unknown>,
  guardRevertJob as JobDefinition<unknown>,
  guardRevertClosedJob as JobDefinition<unknown>,
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
  COMMENTED_STATUSES,
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
export {
  errorClass,
  guardRevertJob,
  openRevert,
  REVERT_JOB,
  type RevertData,
  revertBranch,
  revertKey,
  runRevert,
  scheduleRevert,
} from "./revert.js";
export {
  guardPullRequestClosed,
  guardRevertClosedJob,
  type RevertClosedData,
  revertClosed,
} from "./revert-closed.js";
export { type ConfirmData, type ObserveData, observeKey } from "./schemas.js";
export { pruneOlderThan } from "./store.js";
export { guardTrackJob, type TrackData, trackDefaultBranch } from "./track.js";
