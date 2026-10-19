/**
 * The modes jobs (Phase 1 step 1): `modes.apply` (cron) republishes the policy of a repository
 * whose `policy_mode` an operator changed; `modes.ceiling_fanout` does the same after the server
 * ceiling changed; `installations.refresh_permissions` reads an installation's permissions from
 * the API (D5, in permissions.ts). IDs only in every payload: never text, never a permission set
 * from a webhook.
 */
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import { defineJob } from "../../queue/job.js";
import { getActiveInstallation } from "../installations/store.js";
import { policyFanoutJob } from "../policy/job.js";
import { claimUnappliedModeChanges, markApplied } from "./store.js";

const CEILING_STEP_SECONDS = 1;

// ---------------------------------------------------------------------------------------------
// modes.apply (cron, D6)
// ---------------------------------------------------------------------------------------------

export const MODES_APPLY_JOB = "modes.apply";

/**
 * Claims unapplied `mode_changes` rows (`FOR UPDATE SKIP LOCKED`), sends one repository fan-out
 * per repository with a `policy_mode` row, and marks every claimed row applied. The sends are in
 * the claiming transaction (pg-boss accepts a transaction), so a rolled back claim sends nothing
 * and a sent fan-out is never left unmarked. `guard_mode` and `mcp_write` rows have nothing to
 * republish in this step.
 */
export async function applyModeChanges(
  ctx: JobContext,
): Promise<{ claimed: number; fanouts: number }> {
  return ctx.db.transaction().execute(async (tx) => {
    const rows = await claimUnappliedModeChanges(tx, 50);
    if (rows.length === 0) return { claimed: 0, fanouts: 0 };
    // Oldest first, so the last policy row of a repository is its newest.
    const newestPolicyRow = new Map<number, string>();
    for (const r of rows) if (r.key === "policy_mode") newestPolicyRow.set(r.repository_id, r.id);
    let fanouts = 0;
    for (const [repositoryId, changeId] of newestPolicyRow) {
      const repo = await tx
        .selectFrom("repositories")
        .select(["installation_id", "full_name"])
        .where("id", "=", repositoryId)
        .where("removed_at", "is", null)
        .executeTakeFirst();
      if (!repo || !(await getActiveInstallation(tx, repo.installation_id))) continue;
      const [owner = "", name = ""] = repo.full_name.split("/");
      await ctx.queue.send(
        policyFanoutJob,
        {
          scope: "repository",
          installationId: repo.installation_id,
          repositoryId,
          owner,
          repo: name,
          reason: "mode_change",
          changeId,
          ceilingAt: null,
        },
        { tx, singletonKey: `policy-mode-fanout:${repositoryId}:${changeId}` },
      );
      fanouts++;
    }
    await markApplied(
      tx,
      rows.map((r) => r.id),
      ctx.clock.now(),
    );
    return { claimed: rows.length, fanouts };
  });
}

export const modesApplyJob = defineJob<Record<string, never>>({
  name: MODES_APPLY_JOB,
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  options: { retryLimit: 1 },
  async handle(_data, ctx) {
    const res = await applyModeChanges(ctx);
    if (res.claimed > 0) ctx.log.info(res, "modes apply done");
  },
});

// ---------------------------------------------------------------------------------------------
// modes.ceiling_fanout (D7)
// ---------------------------------------------------------------------------------------------

export const MODES_CEILING_FANOUT_JOB = "modes.ceiling_fanout";

export const ceilingFanoutSchema = z.object({
  /** Epoch ms of the change, so that a later change back to a value is not deduplicated. */
  at: z.number().int().nonnegative(),
});
export type CeilingFanoutData = z.infer<typeof ceilingFanoutSchema>;

export async function fanoutCeilingChange(
  data: CeilingFanoutData,
  ctx: JobContext,
): Promise<number> {
  const repos = await ctx.db
    .selectFrom("repositories as r")
    .innerJoin("installations as i", "i.id", "r.installation_id")
    .select(["r.id", "r.installation_id", "r.full_name"])
    .where("r.removed_at", "is", null)
    .where("i.deleted_at", "is", null)
    .where("i.suspended_at", "is", null)
    .orderBy("r.id")
    .execute();
  for (const [i, r] of repos.entries()) {
    const [owner = "", repo = ""] = r.full_name.split("/");
    await ctx.queue.send(
      policyFanoutJob,
      {
        scope: "repository",
        installationId: r.installation_id,
        repositoryId: r.id,
        owner,
        repo,
        reason: "ceiling_change",
        changeId: null,
        ceilingAt: data.at,
      },
      {
        singletonKey: `policy-ceiling-fanout:${r.id}:${data.at}`,
        startAfterSeconds: i * CEILING_STEP_SECONDS,
      },
    );
  }
  return repos.length;
}

export const modesCeilingFanoutJob = defineJob<CeilingFanoutData>({
  name: MODES_CEILING_FANOUT_JOB,
  schema: ceilingFanoutSchema,
  async handle(data, ctx) {
    const count = await fanoutCeilingChange(data, ctx);
    ctx.log.info({ count }, "modes ceiling fanout done");
  },
});
