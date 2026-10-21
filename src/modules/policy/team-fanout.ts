/**
 * Team and membership triggers (Phase 1 step 2, D14). The `membership` and `team` payloads are
 * triggers only: the handlers read nothing but the installation id, and the fan-out re-evaluates
 * every open PR of the installation whose latest verdict has a team constraint. Team slugs are not
 * stored (Phase 0 D19), so Graft cannot tell which team changed; a 5-minute debounce bounds the
 * cost.
 */
import { sql } from "kysely";
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import { defineJob } from "../../queue/job.js";
import { defineWebhookHandler } from "../../webhooks/handler.js";
import { parsePayload } from "../../webhooks/payload.js";
import { getActiveInstallation } from "../installations/index.js";
import { FANOUT_MAX, policyEvaluateJob } from "./job.js";

export const POLICY_TEAM_FANOUT_JOB = "policy.team_fanout";
const WINDOW_SECONDS = 300;
const START_AFTER_SECONDS = 60;
const FANOUT_BATCH = 10;
const FANOUT_STEP_SECONDS = 5;
const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/;

/** The installation id is all a handler reads (T1 (c)). */
const triggerPayload = z.looseObject({
  installation: z.looseObject({ id: z.number().int().positive() }),
});

export const teamFanoutSchema = z.object({ installationId: z.number().int().positive() });
export type TeamFanoutData = z.infer<typeof teamFanoutSchema>;

export const teamFanoutJob = defineJob<TeamFanoutData>({
  name: POLICY_TEAM_FANOUT_JOB,
  schema: teamFanoutSchema,
  options: { retryLimit: 5, retryDelaySeconds: 30, retryBackoff: true, expireInSeconds: 120 },
  async handle(data, ctx) {
    await fanoutTeamChange(data, ctx);
  },
});

export const scheduleTeamFanout = defineWebhookHandler({
  name: "policy.team",
  on: [
    "membership.added",
    "membership.removed",
    "team.deleted",
    "team.edited",
    "team.added_to_repository",
    "team.removed_from_repository",
  ] as const,
  async handle(event, ctx) {
    const p = parsePayload(triggerPayload, event, ctx.log);
    if (!p) return;
    const installationId = p.installation.id;
    if (!(await getActiveInstallation(ctx.db, installationId))) return;
    const window = Math.floor(ctx.clock.now().getTime() / (WINDOW_SECONDS * 1000));
    await ctx.queue.send(
      teamFanoutJob,
      { installationId },
      {
        singletonKey: `policy:team:${installationId}:${window}`,
        startAfterSeconds: START_AFTER_SECONDS,
      },
    );
  },
});

/** Re-evaluates the installation's team-constrained open PRs (trigger `team`). */
export async function fanoutTeamChange(data: TeamFanoutData, ctx: JobContext): Promise<number> {
  if (!(await getActiveInstallation(ctx.db, data.installationId))) {
    ctx.log.info({ outcome: "skipped", reason: "installation inactive" }, "team fanout done");
    return 0;
  }
  const res = await sql<{ repository_id: string | number; full_name: string; pr_number: number }>`
    SELECT c.repository_id, r.full_name, c.pr_number
    FROM changes c JOIN repositories r ON r.id = c.repository_id
    WHERE r.installation_id = ${data.installationId} AND r.removed_at IS NULL AND c.state = 'open'
      AND EXISTS (SELECT 1 FROM policy_verdicts v
                  WHERE v.change_id = c.id AND v.head_sha = c.head_sha
                    AND jsonb_path_exists(v.required, '$.constraints[*] ? (@.teamCount > 0)'))
    ORDER BY c.pr_updated_at DESC NULLS LAST, c.pr_number DESC
    LIMIT ${FANOUT_MAX + 1}`.execute(ctx.db);
  if (res.rows.length > FANOUT_MAX) {
    ctx.log.warn({ outcome: "fanout_truncated", max: FANOUT_MAX }, "team fanout truncated");
  }
  const window = Math.floor(ctx.clock.now().getTime() / (WINDOW_SECONDS * 1000));
  const chosen = res.rows.slice(0, FANOUT_MAX);
  let sent = 0;
  for (const [i, row] of chosen.entries()) {
    const [owner = "", repo = ""] = row.full_name.split("/");
    if (!NAME_PART.test(owner) || !NAME_PART.test(repo)) continue;
    const repositoryId = Number(row.repository_id);
    await ctx.queue.send(
      policyEvaluateJob,
      {
        installationId: data.installationId,
        repositoryId,
        owner,
        repo,
        prNumber: row.pr_number,
        trigger: "team",
      },
      {
        singletonKey: `policy:team:${repositoryId}:${row.pr_number}:${window}`,
        startAfterSeconds: Math.floor(i / FANOUT_BATCH) * FANOUT_STEP_SECONDS,
      },
    );
    sent++;
  }
  ctx.log.info({ outcome: "enqueued", count: sent }, "team fanout done");
  return sent;
}
