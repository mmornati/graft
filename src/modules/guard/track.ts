/**
 * `guard.track` (Phase 1 step 4, §5, D5, D6): the first-parent history of the default branch,
 * read from the API. A push is only the trigger: the default branch, the commits and the PR behind
 * each commit all come from the API. Stored: SHAs, first parents, a per-repository `seq`, the PR
 * number. Never a commit message or a file.
 */
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import type { GitHubClient } from "../../github/client-factory.js";
import { classifyGitHubError, toJobError } from "../../github/errors.js";
import { PermanentJobError } from "../../queue/errors.js";
import { defineJob } from "../../queue/job.js";
import { type LivePull, upsertChangeFromPull } from "../changes/index.js";
import {
  ensureRepository,
  getActiveInstallation,
  getActiveRepository,
} from "../installations/index.js";
import { scheduleObserve } from "./observe.js";
import { NAME_PART, SHA } from "./schemas.js";
import {
  insertMainCommits,
  markReverted,
  type NewMainCommit,
  storedShas,
  withRepositoryGuardLock,
} from "./store.js";

export const TRACK_JOB = "guard.track";
/** D5: one walk stores at most this many commits. */
export const MAX_WALK = 300;
/** D6: at most this many `commits/{sha}/pulls` lookups per job. */
export const MAX_PR_LOOKUPS = 20;
/** List requests per walk (100 commits each); the walk normally needs far fewer. */
const MAX_LIST_REQUESTS = 10;

export const trackSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: NAME_PART,
  repo: NAME_PART,
  /** The pushed branch (refs/heads/ removed). The job compares it with the API's default branch. */
  branch: z.string().min(1).max(255),
  after: SHA,
  before: SHA.nullable(),
  forced: z.boolean(),
  deliveryId: z.string().max(100).optional(),
});
export type TrackData = z.infer<typeof trackSchema>;

export type TrackOutcome =
  | "disabled"
  | "inactive"
  | "not_default_branch"
  | "rewound"
  | "known"
  | "tracked";

interface ListedCommit {
  sha: string;
  parent: string | null;
  committedAt: Date | null;
}

/** `repos.get`: the default branch, from the API (never from the payload). */
export async function readDefaultBranch(
  octokit: GitHubClient,
  data: { owner: string; repo: string; repositoryId: number; installationId: number },
  ctx: JobContext,
): Promise<string | null> {
  let repo: Awaited<ReturnType<GitHubClient["rest"]["repos"]["get"]>>["data"];
  try {
    repo = (await octokit.rest.repos.get({ owner: data.owner, repo: data.repo })).data;
  } catch (err) {
    throw toJobError(err, "repos.get");
  }
  if (repo.id !== data.repositoryId) {
    throw new PermanentJobError("repository does not match the expected id", "repo_mismatch");
  }
  const state = await ensureRepository(
    ctx.db,
    data.installationId,
    {
      id: repo.id,
      full_name: repo.full_name,
      private: repo.private,
      default_branch: repo.default_branch,
    },
    ctx.clock.now(),
  );
  return state === "active" ? repo.default_branch : null;
}

async function listFrom(
  octokit: GitHubClient,
  data: { owner: string; repo: string },
  sha: string,
): Promise<ListedCommit[]> {
  try {
    const res = await octokit.rest.repos.listCommits({
      owner: data.owner,
      repo: data.repo,
      sha,
      per_page: 100,
    });
    return res.data.map((c) => ({
      sha: c.sha,
      parent: c.parents[0]?.sha ?? null,
      committedAt: c.commit.committer?.date ? new Date(c.commit.committer.date) : null,
    }));
  } catch (err) {
    // An unknown SHA ends the walk; it is a chain break, not a failure.
    if (classifyGitHubError(err) === "not_found" || classifyGitHubError(err) === "invalid") {
      return [];
    }
    throw toJobError(err, "repos.listCommits");
  }
}

type PrMapping = Pick<NewMainCommit, "prSource" | "changeId" | "prNumber">;

/** D6, one commit: `changes` first, then the commit-pulls API (counted by the caller). */
async function mapFromChanges(
  ctx: JobContext,
  repositoryId: number,
  sha: string,
): Promise<PrMapping | null> {
  const row = await ctx.db
    .selectFrom("changes")
    .select(["id", "pr_number"])
    .where("repository_id", "=", repositoryId)
    .where("state", "=", "merged")
    .where("merge_commit_sha", "=", sha)
    .orderBy("pr_number")
    .executeTakeFirst();
  return row ? { prSource: "change", changeId: row.id, prNumber: row.pr_number } : null;
}

async function mapFromApi(
  octokit: GitHubClient,
  ctx: JobContext,
  data: { owner: string; repo: string; repositoryId: number },
  sha: string,
  defaultBranch: string,
): Promise<PrMapping> {
  let pulls: { number: number; merged_at: string | null; base: { ref: string } }[];
  try {
    pulls = (
      await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner: data.owner,
        repo: data.repo,
        commit_sha: sha,
        per_page: 100,
      })
    ).data;
  } catch (err) {
    if (classifyGitHubError(err) === "not_found") {
      return { prSource: "unresolved", changeId: null, prNumber: null };
    }
    throw toJobError(err, "repos.listPullRequestsAssociatedWithCommit");
  }
  const merged = pulls.filter((p) => p.merged_at !== null && p.base.ref === defaultBranch);
  if (merged.length === 0) return { prSource: "direct", changeId: null, prNumber: null };
  if (merged.length > 1) return { prSource: "multiple", changeId: null, prNumber: null };
  const number = (merged[0] as { number: number }).number;
  let pull: LivePull;
  try {
    pull = (
      await octokit.rest.pulls.get({ owner: data.owner, repo: data.repo, pull_number: number })
    ).data as unknown as LivePull;
  } catch (err) {
    throw toJobError(err, "pulls.get");
  }
  if (pull.number !== number || pull.base.repo.id !== data.repositoryId) {
    return { prSource: "unresolved", changeId: null, prNumber: null };
  }
  const { change } = await upsertChangeFromPull(ctx.db, data.repositoryId, pull, ctx.clock.now());
  return { prSource: "api", changeId: change.id, prNumber: number };
}

/**
 * Walks and stores. `enqueueObserve: false` is the inline call from `guard.observe` (D13), which
 * observes the commit itself.
 */
export async function trackDefaultBranch(
  data: TrackData,
  ctx: JobContext,
  o: { enqueueObserve?: boolean; octokit?: GitHubClient } = {},
): Promise<TrackOutcome> {
  if (!ctx.config.guardDetection) return "disabled";
  if (!(await getActiveInstallation(ctx.db, data.installationId))) return "inactive";
  if (!(await getActiveRepository(ctx.db, data.repositoryId))) return "inactive";
  let octokit: GitHubClient;
  try {
    octokit = o.octokit ?? (await ctx.github.forInstallation(data.installationId));
  } catch (err) {
    throw toJobError(err, "installation token");
  }
  const defaultBranch = await readDefaultBranch(octokit, data, ctx);
  if (defaultBranch === null) return "inactive";
  if (data.branch !== defaultBranch) {
    ctx.log.info({ repositoryId: data.repositoryId }, "not_default_branch");
    return "not_default_branch";
  }

  // The walk: API reads, outside any lock.
  const cache = new Map<string, ListedCommit>();
  const fresh: ListedCommit[] = [];
  let need: string | null = data.after;
  let requests = 0;
  const known = await storedShas(ctx.db, data.repositoryId, [data.after]);
  if (known.has(data.after)) {
    const outcome: TrackOutcome = data.forced ? "rewound" : "known";
    if (data.forced) ctx.log.info({ repositoryId: data.repositoryId }, "rewound");
    if (o.enqueueObserve !== false) await observeAfter(data, ctx);
    return outcome;
  }
  while (need !== null && fresh.length < MAX_WALK) {
    if (need === data.before) break;
    if ((await storedShas(ctx.db, data.repositoryId, [need])).has(need)) break;
    let c = cache.get(need);
    if (!c) {
      if (requests >= MAX_LIST_REQUESTS) break;
      requests++;
      for (const listed of await listFrom(octokit, data, need)) cache.set(listed.sha, listed);
      c = cache.get(need);
      if (!c) break;
    }
    fresh.push(c);
    need = c.parent;
  }

  // D6, newest first: the newest commits are the ones detection looks at.
  const mapped = new Map<string, PrMapping>();
  let lookups = 0;
  for (const c of fresh) {
    const fromChanges = await mapFromChanges(ctx, data.repositoryId, c.sha);
    if (fromChanges) mapped.set(c.sha, fromChanges);
    else if (lookups < MAX_PR_LOOKUPS) {
      lookups++;
      mapped.set(c.sha, await mapFromApi(octokit, ctx, data, c.sha, defaultBranch));
    } else mapped.set(c.sha, { prSource: "unresolved", changeId: null, prNumber: null });
  }

  const oldestFirst = [...fresh].reverse();
  const inserted = await withRepositoryGuardLock(ctx.db, data.repositoryId, async (tx) => {
    const already = await storedShas(
      tx,
      data.repositoryId,
      oldestFirst.map((c) => c.sha),
    );
    const todo = oldestFirst.filter((c) => !already.has(c.sha));
    if (todo.length === 0) return 0;
    const oldest = todo[0] as ListedCommit;
    // D5: a forced push, an unknown parent (an unknown `before`, the cap, a root) is a break.
    const parentKnown =
      oldest.parent !== null &&
      (await storedShas(tx, data.repositoryId, [oldest.parent])).has(oldest.parent);
    const rows: NewMainCommit[] = todo.map((c, i) => ({
      sha: c.sha,
      parentSha: c.parent,
      chainBreak: i === 0 && (data.forced || !parentKnown),
      committedAt: c.committedAt,
      ...(mapped.get(c.sha) ?? { prSource: "unresolved", changeId: null, prNumber: null }),
    }));
    const n = await insertMainCommits(tx, data.repositoryId, rows, ctx.clock.now());
    // Step 5 (D18): a default-branch commit that maps to a revert PR means it was merged, even
    // when its `pull_request.closed` webhook was missed. The mapping came from the API.
    const merged = rows.flatMap((r) => (r.prNumber === null ? [] : [r.prNumber]));
    const reverted = await markReverted(tx, data.repositoryId, merged, ctx.clock.now());
    if (reverted > 0)
      ctx.log.info({ repositoryId: data.repositoryId, reverted }, "guard revert merged");
    return n;
  });
  ctx.log.info(
    { repositoryId: data.repositoryId, walked: fresh.length, inserted, lookups },
    "guard history tracked",
  );
  if (o.enqueueObserve !== false) await observeAfter(data, ctx);
  return inserted > 0 ? "tracked" : "known";
}

async function observeAfter(data: TrackData, ctx: JobContext): Promise<void> {
  await scheduleObserve(ctx, {
    installationId: data.installationId,
    repositoryId: data.repositoryId,
    owner: data.owner,
    repo: data.repo,
    sha: data.after,
  });
}

export const guardTrackJob = defineJob<TrackData>({
  name: TRACK_JOB,
  schema: trackSchema,
  options: { retryLimit: 3 },
  async handle(data, ctx) {
    await trackDefaultBranch(data, ctx);
  },
});
