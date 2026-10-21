/**
 * Reviewer eligibility sync (step 6, T4, D5). Webhooks and the `feedback_recorded` signal only
 * enqueue; the job reads the requested reviewers and the reviews from the API and stores user
 * IDs (never logins) in `pr_reviewers`. The table is a union over time: nothing is deleted when a
 * request is withdrawn, because the vote was legitimate when it was cast.
 *
 * Only users with standing on the repository are stored, and every stored row is `verified`:
 * - a review counts only if its `author_association` is OWNER, MEMBER or COLLABORATOR (on a public
 *   repository anyone can submit an APPROVED or CHANGES_REQUESTED review);
 * - a requested user counts only if they hold triage-or-higher permission on the repository
 *   (`collaboratorRole` in `src/github/collaborator.ts`, cached per job): the PR author chooses who is
 *   requested, so a request alone proves nothing.
 */
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import type { SignalListener } from "../../core/signals.js";
import type { GitHubClient } from "../../github/client-factory.js";
import { atLeast, classifiedErrors, collaboratorRole } from "../../github/collaborator.js";
import { classifyGitHubError, toJobError } from "../../github/errors.js";
import { defineJob } from "../../queue/job.js";
import { defineWebhookHandler } from "../../webhooks/handler.js";
import { parsePayload } from "../../webhooks/payload.js";
import { getChangeByNumber, type LivePull, upsertChangeFromPull } from "../changes/index.js";
import { ensureRepository, getActiveInstallation } from "../installations/index.js";
import { addReviewers, recordPermissionDenials } from "./store.js";

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
  /**
   * The user a `review_requested` webhook named. A trigger only: the job still checks their
   * standing through the API, but it records the request even if they leave the requested list
   * (by reviewing) before a later sync runs.
   */
  requested: z
    .object({ id: z.number().int().positive(), login: z.string().min(1).max(100) })
    .optional(),
});
export type SyncData = z.infer<typeof syncSchema>;

export type SyncOutcome = "synced" | "skipped";

/** `author_association` values of a review that prove standing on the repository. */
const REVIEW_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
/** Review states that count as having reviewed (a COMMENTED review is not enough). */
const REVIEW_STATES: ReadonlySet<string> = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
const PERMISSION_ROUTE = "GET /repos/{owner}/{repo}/collaborators/{username}/permission";

/** The answer to one permission check: `denied` is the status GitHub failed it with, if it did. */
interface Standing {
  eligible: boolean;
  denied: 403 | 404 | null;
}

/**
 * Whether the user holds triage-or-higher permission (`collaboratorRole`, D16 of Phase 1 step 2).
 * A 404 or 403 (not a collaborator, no access, the App cannot see it) fails closed and is
 * reported in `denied`; rate limits and 5xx throw so the job retries.
 */
async function checkTriagePermission(
  octokit: GitHubClient,
  o: { owner: string; repo: string; user: { id: number; login: string } },
): Promise<Standing> {
  const answer = await collaboratorRole(octokit, o);
  return { eligible: atLeast(answer.role, "triage"), denied: answer.denied };
}

const MAX_TIMELINE_PAGES = 3;

/** Whether a `review_requested` event on the PR's timeline names this user id. */
async function timelineShowsRequest(
  octokit: GitHubClient,
  data: SyncData,
  userId: number,
): Promise<boolean> {
  try {
    const it = octokit.paginate.iterator(octokit.rest.issues.listEventsForTimeline, {
      owner: data.owner,
      repo: data.repo,
      issue_number: data.prNumber,
      per_page: 100,
    });
    let pages = 0;
    for await (const page of it) {
      for (const e of page.data as unknown as {
        event?: string;
        requested_reviewer?: { id?: number } | null;
      }[]) {
        if (e.event === "review_requested" && e.requested_reviewer?.id === userId) return true;
      }
      if (++pages >= MAX_TIMELINE_PAGES) break;
    }
    return false;
  } catch (err) {
    if (classifyGitHubError(err) === "not_found") return false;
    throw toJobError(err, "list timeline");
  }
}

/** Also used by `pnpm graft pilot sync-reviewers`. Throws a (permanent) job error on a 404. */
export async function syncReviewers(ctx: JobContext, data: SyncData): Promise<SyncOutcome> {
  if (!(await getActiveInstallation(ctx.db, data.installationId))) return "skipped";
  let octokit: GitHubClient;
  try {
    octokit = await ctx.github.forInstallation(data.installationId);
  } catch (err) {
    throw toJobError(err, "installation token");
  }
  let change = await getChangeByNumber(ctx.db, data.repositoryId, data.prNumber);
  if (!change) {
    // A request made as the PR is opened can arrive before the provenance and intent jobs have
    // created the change. Create it from the API (never from the payload) instead of dropping
    // the request: once the reviewer reviews, GitHub no longer lists them as requested.
    let pull: LivePull;
    try {
      const res = await octokit.rest.pulls.get({
        owner: data.owner,
        repo: data.repo,
        pull_number: data.prNumber,
      });
      pull = res.data as unknown as LivePull;
    } catch (err) {
      throw toJobError(err, "pulls.get");
    }
    if (pull.base.repo.id !== data.repositoryId) return "skipped";
    // The same guard as the provenance and intent jobs: never write rows for a repository that
    // Graft considers removed. (A database error here is not a GitHub error.)
    const now = ctx.clock.now();
    if ((await ensureRepository(ctx.db, data.installationId, pull.base.repo, now)) === "removed") {
      return "skipped";
    }
    change = (await upsertChangeFromPull(ctx.db, data.repositoryId, pull, now)).change;
  }
  const found = new Map<string, { userId: number; reason: "requested" | "reviewed" }>();
  const standingCache = new Map<number, Standing>();
  const standing = async (u: { id: number; login: string }): Promise<Standing> => {
    let st = standingCache.get(u.id);
    if (st === undefined) {
      st = await checkTriagePermission(octokit, { owner: data.owner, repo: data.repo, user: u });
      standingCache.set(u.id, st);
    }
    return st;
  };
  let candidates = 0;
  try {
    if (data.requested) {
      // The webhook only names whom to look at. "Was requested" is confirmed from the API: the
      // issue timeline keeps the `review_requested` event after the reviewer has reviewed (the
      // requested list does not), so a forged or replayed claim records nothing.
      const claimed = data.requested;
      if (await timelineShowsRequest(octokit, data, claimed.id)) {
        candidates++;
        if ((await standing(claimed)).eligible) {
          found.set(`requested:${claimed.id}`, { userId: claimed.id, reason: "requested" });
        }
      }
    }
    const requested = await octokit.rest.pulls.listRequestedReviewers({
      owner: data.owner,
      repo: data.repo,
      pull_number: data.prNumber,
    });
    // Users only: expanding a team needs `members: read` (out of scope, Phase 1).
    for (const u of requested.data.users) {
      if (u.type === "Bot") continue;
      candidates++;
      if ((await standing(u)).eligible)
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
        candidates++;
        // A COMMENTED-only review is not enough: on a public repository anyone can leave one.
        // DISMISSED counts: it was an approval or a change request until a push (or a maintainer)
        // dismissed it, and "reviewed once" is enough.
        if (!REVIEW_STATES.has(r.state)) continue;
        // Even an approval proves nothing from an outsider (association NONE, CONTRIBUTOR, ...).
        if (!REVIEW_ASSOCIATIONS.has(r.author_association)) continue;
        // An association does not prove access either (any member of an organisation is a MEMBER
        // of its public repositories; a COLLABORATOR may have read only): same bar as a request.
        if (!(await standing(r.user)).eligible) continue;
        found.set(`reviewed:${r.user.id}`, { userId: r.user.id, reason: "reviewed" });
      }
      if (++pages >= MAX_REVIEW_PAGES) break;
    }
  } catch (err) {
    if (err instanceof Error && classifiedErrors.has(err)) throw err;
    throw toJobError(err, "list reviewers");
  }
  const now = ctx.clock.now();
  const added = await addReviewers(ctx.db, change.id, [...found.values()], now);
  // A 403 or 404 fails closed. Say so (status and route only, never a login), and keep the last
  // answer per user for `pilot doctor`: a missing App permission would otherwise make every
  // reviewer silently ineligible.
  const denied = new Map<number, 403 | 404>();
  const clear: number[] = [];
  for (const [id, st] of standingCache) {
    if (st.denied !== null) {
      denied.set(id, st.denied);
      ctx.log.warn(
        { status: st.denied, route: PERMISSION_ROUTE, prNumber: data.prNumber },
        "reviewer permission check denied (not eligible)",
      );
    } else clear.push(id);
  }
  await recordPermissionDenials(ctx.db, change.id, { denied, clear }, now);
  ctx.log.info(
    {
      prNumber: data.prNumber,
      candidates,
      verified: found.size,
      added,
      permissionForbidden: [...denied.values()].filter((s) => s === 403).length,
      permissionNotFound: [...denied.values()].filter((s) => s === 404).length,
    },
    "reviewer sync done",
  );
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
  requested_reviewer: z
    .looseObject({
      id: z.number().int().positive(),
      login: z.string().min(1),
      type: z.string().optional(),
    })
    .nullish(),
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
        ...(p.action === "review_requested" &&
        p.requested_reviewer &&
        p.requested_reviewer.type !== "Bot"
          ? { requested: { id: p.requested_reviewer.id, login: p.requested_reviewer.login } }
          : {}),
      },
      { singletonKey: `rev-sync:${p.repository.id}:${p.pull_request.number}:${event.deliveryId}` },
    );
  },
});

/**
 * Two signals sync a change's reviewers: its provenance being published for the first time (once
 * per change), and a vote being recorded (at most once per hour per change).
 */
export const onChangeSignal: SignalListener = async (s, ctx) => {
  if (s.kind === "provenance_published") {
    // The change exists now: sync once for it, whatever requests came in before it did.
    await ctx.queue.send(
      reviewersSyncJob,
      {
        installationId: s.installationId,
        repositoryId: s.repositoryId,
        owner: s.owner,
        repo: s.repo,
        prNumber: s.prNumber,
      },
      { singletonKey: `rev-sync-open:${s.repositoryId}:${s.prNumber}` },
    );
    return;
  }
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
