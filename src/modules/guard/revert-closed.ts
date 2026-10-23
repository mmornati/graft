/**
 * The revert PR's lifecycle (Phase 1 step 5, D18). A `pull_request.closed` whose head ref starts
 * with `graft-revert/` (a payload hint only) enqueues `guard.revert_closed`. The job finds the
 * event by its stored `revert_pr_number` (none: stop), reads the PR from the API and sets
 * `reverted` when it was merged, `revert_closed` otherwise. The payload never decides the outcome.
 * `guard.track` catches a missed webhook when it maps a new default-branch commit to the PR.
 */
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import type { GitHubClient } from "../../github/client-factory.js";
import { toJobError } from "../../github/errors.js";
import { defineJob } from "../../queue/job.js";
import { defineWebhookHandler } from "../../webhooks/handler.js";
import { parsePayload } from "../../webhooks/payload.js";
import { getActiveInstallation, getActiveRepository } from "../installations/index.js";
import { eventByRevertPr } from "./store.js";

export const REVERT_CLOSED_JOB = "guard.revert_closed";

export const revertClosedSchema = z.object({
  repositoryId: z.number().int().positive(),
  prNumber: z.number().int().positive(),
});
export type RevertClosedData = z.infer<typeof revertClosedSchema>;

export type RevertClosedOutcome =
  | "disabled"
  | "inactive"
  | "no_event"
  | "open"
  | "reverted"
  | "revert_closed"
  | "settled";

export async function revertClosed(
  data: RevertClosedData,
  ctx: JobContext,
  o: { octokit?: GitHubClient } = {},
): Promise<RevertClosedOutcome> {
  if (!ctx.config.guardDetection) return "disabled";
  const event = await eventByRevertPr(ctx.db, data.repositoryId, data.prNumber);
  if (!event) {
    ctx.log.info({ repositoryId: data.repositoryId }, "guard.revert_closed: no event");
    return "no_event";
  }
  if (event.status !== "revert_opened") return "settled";
  const repository = await getActiveRepository(ctx.db, data.repositoryId);
  if (!repository || !(await getActiveInstallation(ctx.db, repository.installation_id))) {
    return "inactive";
  }
  const [owner = "", repo = ""] = repository.full_name.split("/");
  let octokit: GitHubClient;
  try {
    octokit = o.octokit ?? (await ctx.github.forInstallation(repository.installation_id));
  } catch (err) {
    throw toJobError(err, "installation token");
  }
  let pull: Awaited<ReturnType<GitHubClient["rest"]["pulls"]["get"]>>["data"];
  try {
    pull = (await octokit.rest.pulls.get({ owner, repo, pull_number: data.prNumber })).data;
  } catch (err) {
    throw toJobError(err, "pulls.get");
  }
  if (pull.state !== "closed") return "open";
  const now = ctx.clock.now();
  const merged = pull.merged === true || pull.merged_at !== null;
  // Step 5 review 1, finding 8: conditional, as `markReverted` is, so this job and `guard.track`
  // cannot overwrite each other. A revert PR reopened later stays `revert_closed` and is never
  // counted by the cap again (recorded in decisions.md).
  const res = await ctx.db
    .updateTable("guard_events")
    .set(
      merged
        ? {
            status: "reverted",
            reverted_at: pull.merged_at ? new Date(pull.merged_at) : now,
            updated_at: now,
          }
        : { status: "revert_closed", updated_at: now },
    )
    .where("id", "=", event.id)
    .where("status", "=", "revert_opened")
    .executeTakeFirst();
  if (Number(res.numUpdatedRows ?? 0) === 0) return "settled";
  ctx.log.info({ eventId: event.id, merged }, "guard revert PR closed");
  return merged ? "reverted" : "revert_closed";
}

export const guardRevertClosedJob = defineJob<RevertClosedData>({
  name: REVERT_CLOSED_JOB,
  schema: revertClosedSchema,
  options: { retryLimit: 3 },
  async handle(data, ctx) {
    await revertClosed(data, ctx);
  },
});

const closedPayload = z.looseObject({
  action: z.literal("closed"),
  number: z.number().int().positive(),
  pull_request: z.looseObject({ head: z.looseObject({ ref: z.string() }) }),
  repository: z.looseObject({ id: z.number().int().positive() }),
  installation: z.looseObject({ id: z.number().int().positive() }),
});

export const guardPullRequestClosed = defineWebhookHandler({
  name: "guard.pull_request_closed",
  on: ["pull_request.closed"] as const,
  async handle(event, ctx) {
    if (!ctx.config.guardDetection) return;
    const p = parsePayload(closedPayload, event, ctx.log);
    if (!p) return;
    // A hint only: the job finds the event by the stored PR number and asks the API.
    if (!p.pull_request.head.ref.startsWith("graft-revert/")) return;
    if (!(await getActiveInstallation(ctx.db, p.installation.id))) return;
    await ctx.queue.send(
      guardRevertClosedJob,
      { repositoryId: p.repository.id, prNumber: p.number },
      { singletonKey: `guard:revert_closed:${p.repository.id}:${p.number}` },
    );
  },
});
