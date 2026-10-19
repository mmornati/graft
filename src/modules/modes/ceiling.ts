import type { JobContext } from "../../core/context.js";
import { modesCeilingFanoutJob } from "./jobs.js";
import { casServiceState } from "./store.js";

export const CEILING_STATE_KEY = "mode_ceiling";

/**
 * Called by the worker at start (D7). The ceiling lives in the environment, so a restart is the
 * only way it changes; the database remembers what was last published. When the stored value
 * existed and differs, the one worker whose compare-and-set updated the row asks for every
 * repository's policy to be republished. The first start only stores the value.
 */
export async function publishModeCeiling(
  ctx: Pick<JobContext, "config" | "db" | "log" | "queue" | "clock">,
): Promise<"stored" | "unchanged" | "changed"> {
  const { config, db, log, queue, clock } = ctx;
  log.info({ ceiling: config.modeCeiling }, "mode ceiling");
  const now = clock.now();
  const previous = await casServiceState(db, CEILING_STATE_KEY, config.modeCeiling, now);
  if (previous === null) return "stored";
  if (previous === config.modeCeiling) return "unchanged";
  await queue.send(
    modesCeilingFanoutJob,
    { at: now.getTime() },
    { singletonKey: `ceiling:${now.getTime()}` },
  );
  log.info({ from: previous, to: config.modeCeiling }, "mode ceiling changed");
  return "changed";
}
