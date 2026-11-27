import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import { defineJob } from "../../queue/job.js";
import { closeEligibleBillingPeriods } from "./statement.js";

export const BILLING_CLOSE_JOB = "billing.close-periods";

export const billingCloseJob = defineJob({
  name: BILLING_CLOSE_JOB,
  schema: z.object({}).strict(),
  options: { retryLimit: 2 },
  async handle(_data: Record<string, never>, ctx: JobContext) {
    const result = await closeEligibleBillingPeriods(ctx.db, ctx.clock.now());
    ctx.log.info(result, "billing period close sweep done");
  },
});
