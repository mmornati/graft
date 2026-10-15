/**
 * Reviewer eligibility sync (step 6, T4, D5). Webhooks and the `feedback_recorded` signal only
 * enqueue; the job reads the requested reviewers and the reviews from the API and stores user
 * IDs (never logins) in `pr_reviewers`. The table is a union over time: nothing is deleted when a
 * request is withdrawn, because the vote was legitimate when it was cast.
 */
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import type { SignalListener } from "../../core/signals.js";
import type { GitHubClient } from "../../github/client-factory.js";
import { toJobError } from "../../github/errors.js";
import { defineJob } from "../../queue/job.js";
import { defineWebhookHandler } from "../../webhooks/handler.js";
import { parsePayload } from "../../webhooks/payload.js";
import { getChangeByNumber } from "../changes/index.js";
import { getActiveInstallation } from "../installations/index.js";
import { addReviewers } from "./store.js";

export const REVIEWERS_SYNC_JOB = "pilot.reviewers.sync";
const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const FULL_NAME = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const MAX_REVIEW_PAGES = 3;

export const syncSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: z.string().regex(NAME_PART),
  repo: z.string().regex(NAME_PART),
  prNumber: z.number().int().positive(),
});
export type SyncData = z.infer<typeof syncSchema>;

export type SyncOutcome = "synced" | "skipped";

/** Also used by `pnpm graft pilot sync-reviewers`. Throws a (permanent) job error on a 404. */
export async function syncReviewers(ctx: JobContext, data: SyncData): Promise<SyncOutcome> {
  if (!(await getActiveInstallation(ctx.db, data.installationId))) return "skipped";
  const change = await getChangeByNumber(ctx.db, data.repositoryId, data.prNumber);
  if (!change) return "skipped";
  let octokit: GitHubClient;
  try {
    octokit = await ctx.github.forInstallation(data.installationId);
  } catch (err) {
    throw toJobError(err, "installation token");
  }
  const found = new Map<string, { userId: number; reason: "requested" | "reviewed" }>();
  try {
    const requested = await octokit.rest.pulls.listRequestedReviewers({
      owner: data.owner,
      repo: data.repo,
      pull_number: data.prNumber,
    });
    // Users only: expanding a team needs `members: read` (out of scope, Phase 1).
    for (const u of requested.data.users) {
      if (u.type === "Bot") continue;
      found.set(`requested:${u.id}`, { userId: u.id, reason: "requested" });
    }
    let pages = 0;
    const it = octokit.paginate.iterator(octokit.rest.pulls.listReviews, {
      owner: data.owner,
      repo: data.repo,
      pull_number: data.prNumber,
      per_page: 100,
    });
    for await (const page of it) {
      for (const r of page.data) {
        if (!r.user || r.user.type === "Bot") continue;
        // A COMMENTED-only review is not enough: on a public repository anyone can leave one.
        // DISMISSED counts: it was an approval or a change request until a push (or a maintainer)
        // dismissed it, and "reviewed once" is enough.
        if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) continue;
        found.set(`reviewed:${r.user.id}`, { userId: r.user.id, reason: "reviewed" });
      }
      if (++pages >= MAX_REVIEW_PAGES) break;
    }
  } catch (err) {
    throw toJobError(err, "list reviewers");
  }
  const added = await addReviewers(ctx.db, change.id, [...found.values()], ctx.clock.now());
  ctx.log.info({ prNumber: data.prNumber, seen: found.size, added }, "reviewer sync done");
  return "synced";
}

export const reviewersSyncJob = defineJob<SyncData>({
  name: REVIEWERS_SYNC_JOB,
  schema: syncSchema,
  options: { retryLimit: 3 },
  async handle(data, ctx) {
    await syncReviewers(ctx, data);
  },
});

const reviewerPayload = z.looseObject({
  action: z.enum(["review_requested", "closed", "submitted"]),
  pull_request: z.looseObject({ number: z.number().int().positive() }),
  repository: z.looseObject({ id: z.number().int().positive(), full_name: FULL_NAME }),
  installation: z.looseObject({ id: z.number().int().positive() }),
});

export const scheduleReviewerSync = defineWebhookHandler({
  name: "pilot.reviewers.schedule",
  on: [
    "pull_request.review_requested",
    "pull_request.closed",
    "pull_request_review.submitted",
  ] as const,
  async handle(event, ctx) {
    const p = parsePayload(reviewerPayload, event, ctx.log);
    if (!p) return;
    if (!(await getActiveInstallation(ctx.db, p.installation.id))) return;
    const [owner = "", repo = ""] = p.repository.full_name.split("/");
    await ctx.queue.send(
      reviewersSyncJob,
      {
        installationId: p.installation.id,
        repositoryId: p.repository.id,
        owner,
        repo,
        prNumber: p.pull_request.number,
      },
      { singletonKey: `rev-sync:${p.repository.id}:${p.pull_request.number}:${event.deliveryId}` },
    );
  },
});

/** A vote was recorded: sync that change's reviewers, at most once per hour per change. */
export const onFeedbackRecorded: SignalListener = async (s, ctx) => {
  if (s.kind !== "feedback_recorded") return;
  await ctx.queue.send(
    reviewersSyncJob,
    {
      installationId: s.installationId,
      repositoryId: s.repositoryId,
      owner: s.owner,
      repo: s.repo,
      prNumber: s.prNumber,
    },
    {
      singletonKey: `rev-sync:${s.repositoryId}:${s.prNumber}:${Math.floor(ctx.clock.now().getTime() / 3_600_000)}`,
    },
  );
};
