import type { Config } from "../config/index.js";
import { feedbackSweepJob } from "../modules/intent/index.js";
import { modesApplyJob, refreshAllPermissionsJob } from "../modules/modes/index.js";
import { metricsRollupJob } from "../modules/pilot/index.js";
import type { JobQueue } from "../queue/queue.js";

/**
 * The worker owns the cron schedules (D23). Switching a cron off (`off`) removes an existing
 * schedule, so a changed environment value takes effect at the next start.
 */
export async function applyCronSchedules(
  queue: Pick<JobQueue, "schedule" | "unschedule">,
  config: Pick<
    Config,
    "feedbackPollCron" | "metricsRollupCron" | "modeApplyCron" | "permissionsRefreshCron"
  >,
): Promise<void> {
  if (config.feedbackPollCron) await queue.schedule(feedbackSweepJob, config.feedbackPollCron, {});
  else await queue.unschedule(feedbackSweepJob);
  if (config.metricsRollupCron) {
    await queue.schedule(metricsRollupJob, config.metricsRollupCron, {});
  } else {
    await queue.unschedule(metricsRollupJob);
  }
  if (config.modeApplyCron) await queue.schedule(modesApplyJob, config.modeApplyCron, {});
  else await queue.unschedule(modesApplyJob);
  if (config.permissionsRefreshCron) {
    await queue.schedule(refreshAllPermissionsJob, config.permissionsRefreshCron, {});
  } else {
    await queue.unschedule(refreshAllPermissionsJob);
  }
}
