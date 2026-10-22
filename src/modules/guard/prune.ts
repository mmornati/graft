/** `guard.prune` (Phase 1 step 4, D15): the daily cron that bounds the guard's storage. */
import { z } from "zod";
import { defineJob } from "../../queue/job.js";
import { pruneOlderThan } from "./store.js";

export const PRUNE_JOB = "guard.prune";
const DAY_MS = 86_400_000;

export const guardPruneJob = defineJob<Record<string, never>>({
  name: PRUNE_JOB,
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  options: { retryLimit: 2 },
  async handle(_data, ctx) {
    // D14: with the kill switch off the cron does nothing.
    if (!ctx.config.guardDetection) return;
    const cutoff = new Date(ctx.clock.now().getTime() - ctx.config.guardRetentionDays * DAY_MS);
    const deleted = await pruneOlderThan(ctx.db, cutoff);
    ctx.log.info(deleted, "guard history pruned");
  },
});
