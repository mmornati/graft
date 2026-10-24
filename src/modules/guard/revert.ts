/**
 * `guard.revert` (Phase 1 step 5, §7): a confirmed culprit becomes a revert pull request in
 * enforce mode, and a plan in the guard comment in report mode.
 *
 * 1-4. Gates: activity, the event (D3, D4), the modes (D2), the kill switch (D19).
 * 5.   Plan with the default client, GETs only, outside every lock (D5–D8, D16, D20).
 * 6.   Report mode stops here: the outcome and the would-be auto-merge decision are stored.
 * 7.   Claim under the repository lock (D13, D17 a/e, D21).
 * 8.   Writes through the `guard` feature client, each result stored before the next (D17 b):
 *      tree (D9, verified), commit, ref, pull request, label.
 * 9.   Auto-merge (D14, D15).
 * 10.  The guard comment, under the change lock, in every mode.
 *
 * This is the only place a `guard` feature client is made. Paths, titles and bodies are never
 * logged or stored: counts, SHAs and reason codes only.
 */
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import { canRetry } from "../../core/context.js";
import { withChangeLock } from "../../db/locks.js";
import type { GuardFailingCheck } from "../../db/schema.js";
import type { GitHubClient } from "../../github/client-factory.js";
import { toJobError } from "../../github/errors.js";
import {
  ENABLE_AUTO_MERGE_MUTATION,
  MutationRefusedError,
  REVERT_LABEL,
} from "../../github/mutation-guard.js";
import { allowedByGuardChecks } from "../../guard/detect.js";
import {
  type AutoMergeReason,
  autoMergeEligibility,
  type Change,
  culpritRange,
  diffTrees,
  entryAt,
  type NeedsHumanReason,
  type Plan,
  planRevert,
  revertTreeEntries,
  sameEntry,
  TreeReadBudgetExceeded,
} from "../../guard/revert-plan.js";
import {
  type AutoMergeView,
  type Person,
  type RevertSection,
  revertBody,
  revertCommitMessage,
  revertTitle,
  type SkipReason,
} from "../../guard/revert-text.js";
import type { ModeState } from "../../modes/index.js";
import { POLICY_PATH } from "../../policy/constants.js";
import { loadBasePolicy } from "../../policy/load.js";
import type { AutoMergeRisk, RiskClass } from "../../policy/schema.js";
import { PermanentJobError } from "../../queue/errors.js";
import { defineJob } from "../../queue/job.js";
import { mergedUnderBreakGlass } from "../audit/index.js";
import { type Change as ChangeRow, getChange } from "../changes/index.js";
import { getActiveInstallation, getActiveRepository } from "../installations/index.js";
import { getEffectiveModes } from "../modes/index.js";
import { getChangeProvenance } from "../provenance/index.js";
import { COMMENTED_STATUSES, githubWebBase, publishGuardComment } from "./comment.js";
import { NAME_PART } from "./schemas.js";
import {
  childOf,
  countOpenReverts,
  eventByRevertPr,
  type GuardEventRow,
  getEvent,
  getEventForUpdate,
  getMainCommit,
  otherRevertOfCulprit,
  resultsAt,
  updateEvent,
  withRepositoryGuardLock,
} from "./store.js";
import { type ApiTreeReader, apiTreeReader } from "./trees.js";

export const REVERT_JOB = "guard.revert";

export const revertSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: NAME_PART,
  repo: NAME_PART,
  eventId: z.uuid(),
});
export type RevertData = z.infer<typeof revertSchema>;

/** D1: one `guard.revert` per event. */
export const revertKey = (eventId: string): string => `guard:revert:${eventId}`;

export const revertBranch = (eventId: string): string => `graft-revert/${eventId}`;

/** The files the policy loader reads (§6 `policyPaths`). */
const POLICY_PATHS = [POLICY_PATH] as const;
const MERGE_METHODS = ["SQUASH", "MERGE", "REBASE"] as const;
type MergeMethod = (typeof MERGE_METHODS)[number];
/** Rows read after the culprit's first commit for the D5 range; more is history_incomplete. */
const MAX_RANGE_ROWS = 2_000;

export type RevertRun = "disabled" | "inactive" | "stopped" | "commented";

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** The stored class of a permanent failure: `tree_mismatch`, `github_404`, … (at most 40). */
export function errorClass(err: unknown): string {
  if (err instanceof PermanentJobError) {
    if (err.reason === "tree_mismatch" || err.reason === "auto_merge_mismatch") return err.reason;
    const status = (err.cause as { status?: unknown } | undefined)?.status;
    if (typeof status === "number") return `github_${status}`;
    return `github_${err.reason}`.slice(0, 40);
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return `github_${status}`;
  return "github_error";
}

const isRetryable = (err: unknown): boolean => !(err instanceof PermanentJobError);

/** `toJobError` for a write, keeping a mutation guard refusal as it is (step 9: `mode_changed`). */
const writeError = (err: unknown, what: string): Error =>
  err instanceof MutationRefusedError ? err : toJobError(err, what);

/**
 * Step 5 review 1, finding 5: a refusal because the mode went back (`mode_report`, `mode_off`) is
 * `mode_changed`; any other refusal (a deactivated repository, a body or route Graft should never
 * send) is `refused_<reason>`, so a defect does not read as a rollback.
 */
export function refusalClass(err: MutationRefusedError): string {
  if (err.refusal === "mode_report" || err.refusal === "mode_off") return "mode_changed";
  return `refused_${err.refusal}`.slice(0, 40);
}

/**
 * Step 5 review 1, finding 4: an event whose culprit was confirmed (or, without a confirmation
 * time, detected) longer ago than the configured bound. The confirmation, not the detection, is
 * what sends `guard.revert`, so a long confirmation window does not make every event stale.
 */
export function isStale(
  e: Pick<GuardEventRow, "confirmed_at" | "detected_at" | "created_at">,
  now: Date,
  maxAgeHours: number,
): boolean {
  const since = e.confirmed_at ?? e.detected_at ?? e.created_at;
  return now.getTime() - since.getTime() > maxAgeHours * 3_600_000;
}

/**
 * Step 5 review 1, nit 11: a `planned` outcome was decided in report mode, so its comment carries
 * the report line even when the comment is written later, after the repository moved to enforce.
 */
function modeFor(
  row: GuardEventRow,
  mode: ModeState<"report" | "enforce">,
): ModeState<"report" | "enforce"> {
  return row.revert_outcome === "planned" && mode.effective === "enforce"
    ? { ...mode, requested: "report", effective: "report" }
    : mode;
}

// ---------------------------------------------------------------------------------------------
// What the plan needs (step 5)
// ---------------------------------------------------------------------------------------------

interface RepoSettings {
  defaultBranch: string;
  allowAutoMerge: boolean;
  mergeMethod: MergeMethod | null;
}

interface Culprit {
  number: number;
  nodeId: string;
  author: Person | null;
  mergedBy: Person | null;
  mergedHead: string;
}

interface Baseline {
  checks: Set<string> | null;
  autoMerge: AutoMergeRisk[] | "not_configured" | "policy_invalid";
}

interface Gathered {
  range: { base: string; head: string };
  repo: RepoSettings;
  tip: { sha: string; tree: string };
  baseTree: string;
  headTree: string;
  baseline: Baseline;
  remaining: GuardFailingCheck[];
  culprit: Culprit;
}

type Early =
  | { kind: "needs_human"; reason: NeedsHumanReason; conflicts: string[] }
  | { kind: "skipped"; reason: SkipReason };

/** D5 from the stored history: the culprit's commits on the default branch. */
async function rangeFromDb(
  ctx: JobContext,
  event: GuardEventRow,
  change: ChangeRow,
): Promise<{ base: string; head: string } | null> {
  const mine = (r: { change_id: string | null; pr_number: number | null }) =>
    r.change_id === change.id || (r.change_id === null && r.pr_number === change.pr_number);
  const first = await ctx.db
    .selectFrom("main_commits")
    .select((eb) => eb.fn.min("seq").as("seq"))
    .where("repository_id", "=", event.repository_id)
    .where((eb) =>
      eb.or([
        eb("change_id", "=", change.id),
        eb.and([eb("change_id", "is", null), eb("pr_number", "=", change.pr_number)]),
      ]),
    )
    .executeTakeFirst();
  if (first?.seq === null || first?.seq === undefined) return null;
  const rows = await ctx.db
    .selectFrom("main_commits")
    .selectAll()
    .where("repository_id", "=", event.repository_id)
    .where("seq", ">=", first.seq)
    .orderBy("seq")
    .limit(MAX_RANGE_ROWS)
    .execute();
  if (rows.length >= MAX_RANGE_ROWS) return null;
  const range = culpritRange(
    rows.map((r) => ({
      sha: r.sha,
      parentSha: r.parent_sha,
      seq: Number(r.seq),
      chainBreak: r.chain_break,
      culprit: mine({
        change_id: r.change_id,
        pr_number: r.pr_number === null ? null : Number(r.pr_number),
      }),
    })),
  );
  return "kind" in range ? null : { base: range.base, head: range.head };
}

/** D16: `graft.yaml` at the baseline: `guard.checks` and `guard.auto_merge_reverts`. */
async function baselineAt(octokit: GitHubClient, data: RevertData, sha: string): Promise<Baseline> {
  let loaded: Awaited<ReturnType<typeof loadBasePolicy>>;
  try {
    loaded = await loadBasePolicy(octokit, {
      repositoryId: data.repositoryId,
      owner: data.owner,
      repo: data.repo,
      commitSha: sha,
    });
  } catch (err) {
    // A file Graft cannot use: every key counts, and auto-merge is off. Transient: retried.
    if (err instanceof PermanentJobError) return { checks: null, autoMerge: "policy_invalid" };
    throw err;
  }
  if (loaded.status === "missing") return { checks: null, autoMerge: "not_configured" };
  if (loaded.status === "invalid") return { checks: null, autoMerge: "policy_invalid" };
  const g = loaded.policy.guard;
  return {
    checks: g?.checks === undefined ? null : new Set(g.checks),
    autoMerge: g?.autoMergeReverts === undefined ? "not_configured" : g.autoMergeReverts,
  };
}

async function readRepo(octokit: GitHubClient, data: RevertData): Promise<RepoSettings> {
  let repo: Awaited<ReturnType<GitHubClient["rest"]["repos"]["get"]>>["data"];
  try {
    repo = (await octokit.rest.repos.get({ owner: data.owner, repo: data.repo })).data;
  } catch (err) {
    throw toJobError(err, "repos.get");
  }
  if (repo.id !== data.repositoryId) {
    throw new PermanentJobError("repository does not match the expected id", "repo_mismatch");
  }
  const allowed: Record<MergeMethod, boolean> = {
    SQUASH: repo.allow_squash_merge === true,
    MERGE: repo.allow_merge_commit === true,
    REBASE: repo.allow_rebase_merge === true,
  };
  return {
    defaultBranch: repo.default_branch,
    allowAutoMerge: repo.allow_auto_merge === true,
    mergeMethod: MERGE_METHODS.find((m) => allowed[m]) ?? null,
  };
}

async function readTip(
  octokit: GitHubClient,
  reader: ApiTreeReader,
  data: RevertData,
  branch: string,
): Promise<{ sha: string; tree: string }> {
  let sha: string;
  try {
    sha = (
      await octokit.rest.git.getRef({ owner: data.owner, repo: data.repo, ref: `heads/${branch}` })
    ).data.object.sha;
  } catch (err) {
    throw toJobError(err, "git.getRef");
  }
  return { sha, tree: (await reader.commit(sha)).tree };
}

const person = (u: unknown): Person | null => {
  const v = u as { login?: unknown; type?: unknown } | null | undefined;
  return typeof v?.login === "string" && typeof v.type === "string"
    ? { login: v.login, type: v.type }
    : null;
};

async function readCulprit(
  octokit: GitHubClient,
  data: RevertData,
  number: number,
): Promise<Culprit> {
  let pull: Awaited<ReturnType<GitHubClient["rest"]["pulls"]["get"]>>["data"];
  try {
    pull = (
      await octokit.rest.pulls.get({ owner: data.owner, repo: data.repo, pull_number: number })
    ).data;
  } catch (err) {
    throw toJobError(err, "pulls.get");
  }
  if (pull.number !== number || pull.base.repo.id !== data.repositoryId) {
    throw new PermanentJobError("culprit pull request does not match", "culprit_mismatch");
  }
  return {
    number,
    nodeId: pull.node_id,
    author: person(pull.user),
    mergedBy: person(pull.merged_by),
    mergedHead: pull.head.sha,
  };
}

/** Step 5, the reads (all GETs). A D5 or D20 result ends it early. */
async function gather(
  ctx: JobContext,
  octokit: GitHubClient,
  reader: ApiTreeReader,
  data: RevertData,
  event: GuardEventRow,
  change: ChangeRow,
): Promise<Gathered | Early> {
  const range = await rangeFromDb(ctx, event, change);
  if (range === null) return { kind: "needs_human", reason: "history_incomplete", conflicts: [] };
  const repo = await readRepo(octokit, data);
  const tip = await readTip(octokit, reader, data, repo.defaultBranch);
  // Step 5 review 1, nit 10: never the failing commit, which the culprit controls (D16). With no
  // last green commit (not reachable today), every key counts and auto-merge is off.
  const baseline: Baseline =
    event.last_green_sha === null
      ? { checks: null, autoMerge: "not_configured" }
      : await baselineAt(octokit, data, event.last_green_sha);
  // D20: a key must be in scope at the newer baseline too.
  const remaining = event.failing_checks.filter((c) =>
    allowedByGuardChecks(baseline.checks, c.name),
  );
  if (remaining.length === 0) return { kind: "skipped", reason: "filtered_at_baseline" };
  const culprit = await readCulprit(octokit, data, change.pr_number);
  const baseTree = (await reader.commit(range.base)).tree;
  const headTree = (await reader.commit(range.head)).tree;
  return { range, repo, tip, baseTree, headTree, baseline, remaining, culprit };
}

/** D14's database inputs: the card at the merged head, break-glass, provenance. */
async function culpritFacts(ctx: JobContext, changeId: string, mergedHead: string) {
  const card = await ctx.db
    .selectFrom("intent_cards")
    .select(["status", "risk_class"])
    .where("change_id", "=", changeId)
    .where("head_sha", "=", mergedHead)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  const breakGlass = await mergedUnderBreakGlass(ctx.db, changeId, mergedHead);
  const prov = await getChangeProvenance(ctx.db, changeId);
  const atHead = prov !== undefined && prov.head_sha === mergedHead ? prov : undefined;
  return {
    card: card ? { status: card.status, risk: card.risk_class as RiskClass } : null,
    breakGlass,
    task: atHead?.task_external_id ?? null,
    sessionUrl: atHead?.session_url ?? null,
  };
}

function eligibility(
  g: Gathered,
  facts: Awaited<ReturnType<typeof culpritFacts>>,
  touchesPolicyFile: boolean,
) {
  return autoMergeEligibility({
    opened: true,
    listed: g.baseline.autoMerge,
    card: facts.card,
    breakGlass: facts.breakGlass,
    touchesPolicyFile,
    repoAllowsAutoMerge: g.repo.allowAutoMerge && g.repo.mergeMethod !== null,
  });
}

// ---------------------------------------------------------------------------------------------
// Writes (step 8), through the guard client
// ---------------------------------------------------------------------------------------------

export interface WriteInput {
  data: RevertData;
  eventId: string;
  changeId: string;
  defaultBranch: string;
  tip: { sha: string; tree: string };
  changes: readonly Change[];
  /** Reads the trees written (the D9 check) with the default client's cache. */
  reader: ApiTreeReader;
  message: string;
  title: string;
  body: string;
}

async function storePr(
  ctx: JobContext,
  w: Pick<WriteInput, "eventId" | "changeId">,
  pr: { number: number; state: string; merged: boolean },
  branch: string,
): Promise<void> {
  const now = ctx.clock.now();
  const status = pr.state === "open" ? "revert_opened" : pr.merged ? "reverted" : "revert_closed";
  await withChangeLock(ctx.db, w.changeId, async (tx) => {
    await updateEvent(
      tx,
      w.eventId,
      {
        status,
        revertBranch: branch,
        revertPrNumber: pr.number,
        revertOutcome: "opened",
        revertReason: null,
        ...(status === "reverted" ? { revertedAt: now } : {}),
      },
      now,
    );
  });
}

/** D17 c/d: the revert PR of this event's branch, open or closed. */
async function findPr(
  gh: GitHubClient,
  w: Pick<WriteInput, "data" | "eventId">,
): Promise<{ number: number; nodeId: string; state: string; merged: boolean } | null> {
  const branch = revertBranch(w.eventId);
  let list: Awaited<ReturnType<GitHubClient["rest"]["pulls"]["list"]>>["data"];
  try {
    list = (
      await gh.rest.pulls.list({
        owner: w.data.owner,
        repo: w.data.repo,
        head: `${w.data.owner}:${branch}`,
        state: "all",
        per_page: 10,
      })
    ).data;
  } catch (err) {
    throw toJobError(err, "pulls.list");
  }
  const hit = list.find((p) => p.head.ref === branch);
  return hit
    ? { number: hit.number, nodeId: hit.node_id, state: hit.state, merged: hit.merged_at !== null }
    : null;
}

/**
 * Phase 1 step 7 (D4, step 5 review 2, finding A): the last attempt of a run failed after its
 * writes began (`revert_branch` or `revert_commit_sha` stored) and before the PR number was stored.
 * What GitHub holds after a retryable failure is never settled `error`: a PR found by head with
 * the default client is adopted (`revert_opened`, outcome `opened`), so the next `guard.revert`
 * resumes its label and auto-merge; otherwise (no PR, or the lookup fails) no outcome is written, and the next observe
 * re-sends `guard.revert` once the job row expires, which resumes from the stored steps (the
 * `stale` rule exempts an event whose writes began). Both keep exactly one revert per event.
 *
 * Step 7 review 1, finding 1: only a retryable error on the last attempt is left resumable. A
 * permanent error (a 422, 404 or 403) would fail again on every resumed run, hold a cap slot and
 * never be reported, so it looks the PR up once: a PR found is adopted, and otherwise (no PR, or
 * the lookup fails) this returns null and the caller settles `error` with a comment, as before
 * step 7. The ref left behind is deleted by the stale-branch rule of a later run.
 * Returns null when the event's writes had not begun (the caller settles as before).
 */
async function settleBegunWrites(
  ctx: JobContext,
  data: RevertData,
  octokit: GitHubClient | null,
  cause: unknown,
): Promise<"adopted" | "resumable" | null> {
  const e = await getEvent(ctx.db, data.eventId);
  if (
    e === undefined ||
    e.culprit_change_id === null ||
    e.revert_outcome !== null ||
    e.revert_pr_number !== null ||
    (e.revert_branch === null && e.revert_commit_sha === null)
  ) {
    return null;
  }
  try {
    const gh = octokit ?? (await ctx.github.forInstallation(data.installationId));
    const found = await findPr(gh, { data, eventId: e.id });
    if (found) {
      await storePr(
        ctx,
        { eventId: e.id, changeId: e.culprit_change_id },
        found,
        revertBranch(e.id),
      );
      ctx.log.info(
        { eventId: e.id, prNumber: found.number },
        "guard revert adopted after its last attempt",
      );
      return "adopted";
    }
  } catch (err) {
    ctx.log.warn(
      { eventId: e.id, errorClass: errorClass(err) },
      "guard revert lookup failed after its last attempt",
    );
  }
  if (!isRetryable(cause)) return null;
  ctx.log.info({ eventId: e.id }, "guard revert left resumable after its last attempt");
  return "resumable";
}

async function sameCommit(
  reader: ApiTreeReader,
  sha: string,
  tree: string,
  parent: string,
): Promise<boolean> {
  const c = await reader.commit(sha);
  return c.tree === tree && c.parents.length === 1 && c.parents[0] === parent;
}

/**
 * D9: the tree written is the tip with exactly the plan undone. Every plan path holds its `before`
 * entry, and nothing else differs from the tip (step 5 review 1, finding 2: the diff from the tip
 * catches a directory GitHub did not delete and a path the request did not name). A tree that
 * cannot be read within the budget does not match.
 */
async function treeMatchesPlan(w: WriteInput, tree: string): Promise<boolean> {
  try {
    for (const c of w.changes) {
      if (!sameEntry(await entryAt(w.reader, tree, c.path), c.before)) return false;
    }
    const written = await diffTrees(w.reader, w.tip.tree, tree, {
      maxPaths: w.changes.length,
      maxTreeReads: Number.POSITIVE_INFINITY,
    });
    if (!Array.isArray(written) || written.length !== w.changes.length) return false;
    const planned = new Map(w.changes.map((c) => [c.path, c] as const));
    return written.every((d) => {
      const c = planned.get(d.path);
      return c !== undefined && sameEntry(d.before, c.after) && sameEntry(d.after, c.before);
    });
  } catch (err) {
    if (err instanceof TreeReadBudgetExceeded) return false;
    throw err;
  }
}

/**
 * Step 8 (D9–D11, D17 b–d): opens the revert pull request, resuming from what the event row says
 * is already done. `gh` must be a `guard` feature client: in report mode the mutation guard
 * refuses its first write before anything is sent (I-REV-3). Returns the PR and its node id.
 */
export async function openRevert(
  ctx: JobContext,
  gh: GitHubClient,
  w: WriteInput,
): Promise<{ number: number; nodeId: string }> {
  const { owner, repo } = w.data;
  const branch = revertBranch(w.eventId);
  const now = () => ctx.clock.now();
  let e = await getEvent(ctx.db, w.eventId);
  if (!e) throw new PermanentJobError("guard event vanished", "event_missing");

  if (e.revert_pr_number !== null) {
    const found = await findPr(gh, w);
    if (found?.number === e.revert_pr_number) return found;
    let pull: Awaited<ReturnType<GitHubClient["rest"]["pulls"]["get"]>>["data"];
    try {
      pull = (await gh.rest.pulls.get({ owner, repo, pull_number: e.revert_pr_number })).data;
    } catch (err) {
      throw toJobError(err, "pulls.get");
    }
    return { number: pull.number, nodeId: pull.node_id };
  }
  // D17 d: an earlier run may have opened the PR without storing it.
  if (e.revert_commit_sha !== null || e.revert_branch !== null) {
    const found = await findPr(gh, w);
    if (found) {
      await storePr(ctx, w, found, branch);
      ctx.log.info({ eventId: w.eventId, prNumber: found.number }, "guard revert PR adopted");
      return found;
    }
  }

  if (e.revert_branch === null) {
    // D9: the tree, then its check against the plan before anything is visible.
    let tree: string;
    try {
      tree = (
        await gh.rest.git.createTree({
          owner,
          repo,
          base_tree: w.tip.tree,
          tree: revertTreeEntries(w.changes) as {
            path: string;
            mode: "100644" | "100755" | "040000" | "160000" | "120000";
            type: "blob" | "tree" | "commit";
            sha: string | null;
          }[],
        })
      ).data.sha;
    } catch (err) {
      throw writeError(err, "git.createTree");
    }
    if (!(await treeMatchesPlan(w, tree))) {
      throw new PermanentJobError("revert tree does not restore the plan", "tree_mismatch");
    }
    // D10: the commit (an earlier run's is reused when it is the same tree on the same tip).
    let commit = e.revert_commit_sha;
    if (commit === null || !(await sameCommit(w.reader, commit, tree, w.tip.sha))) {
      try {
        commit = (
          await gh.rest.git.createCommit({
            owner,
            repo,
            message: w.message,
            tree,
            parents: [w.tip.sha],
          })
        ).data.sha;
      } catch (err) {
        throw writeError(err, "git.createCommit");
      }
      await updateEvent(ctx.db, w.eventId, { revertCommitSha: commit }, now());
    }
    // The branch: a name that is a function of the event only.
    const createRef = () =>
      gh.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit as string });
    try {
      await createRef();
    } catch (err) {
      if ((err as { status?: unknown }).status !== 422) throw writeError(err, "git.createRef");
      // D17 c: the branch exists. A PR from it is adopted; otherwise the branch is reused when it
      // holds the planned tree on the tip, or deleted and created again.
      const found = await findPr(gh, w);
      if (found) {
        await storePr(ctx, w, found, branch);
        ctx.log.info({ eventId: w.eventId, prNumber: found.number }, "guard revert PR adopted");
        return found;
      }
      let existing: string;
      try {
        existing = (await gh.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })).data.object
          .sha;
      } catch (e2) {
        throw toJobError(e2, "git.getRef");
      }
      if (existing !== commit && (await sameCommit(w.reader, existing, tree, w.tip.sha))) {
        commit = existing;
        await updateEvent(ctx.db, w.eventId, { revertCommitSha: commit }, now());
      } else if (existing !== commit) {
        try {
          // The literal path: Octokit would percent-encode the slashes of a `{ref}` parameter.
          await gh.request(`DELETE /repos/{owner}/{repo}/git/refs/heads/${branch}`, {
            owner,
            repo,
          });
        } catch (e3) {
          throw writeError(e3, "git.deleteRef");
        }
        ctx.log.info({ eventId: w.eventId }, "stale guard revert branch deleted");
        try {
          await createRef();
        } catch (e4) {
          throw writeError(e4, "git.createRef");
        }
      }
    }
    await updateEvent(ctx.db, w.eventId, { revertBranch: branch }, now());
    e = { ...e, revert_branch: branch, revert_commit_sha: commit };
  }

  // D11: the pull request.
  let pr: { number: number; nodeId: string; state: string; merged: boolean };
  try {
    const data = (
      await gh.rest.pulls.create({
        owner,
        repo,
        head: branch,
        base: w.defaultBranch,
        title: w.title,
        body: w.body,
        draft: false,
        maintainer_can_modify: false,
      })
    ).data;
    pr = { number: data.number, nodeId: data.node_id, state: "open", merged: false };
  } catch (err) {
    if ((err as { status?: unknown }).status !== 422) throw writeError(err, "pulls.create");
    const found = await findPr(gh, w);
    if (!found) throw writeError(err, "pulls.create");
    pr = found;
  }
  await storePr(ctx, w, pr, branch);
  ctx.log.info({ eventId: w.eventId, prNumber: pr.number }, "guard revert PR opened");
  return pr;
}

/** D11: the label, once. */
async function labelRevert(
  ctx: JobContext,
  gh: GitHubClient,
  data: RevertData,
  eventId: string,
  prNumber: number,
): Promise<void> {
  try {
    await gh.rest.issues.addLabels({
      owner: data.owner,
      repo: data.repo,
      issue_number: prNumber,
      labels: [REVERT_LABEL],
    });
  } catch (err) {
    throw writeError(err, "issues.addLabels");
  }
  await updateEvent(ctx.db, eventId, { revertLabelled: true }, ctx.clock.now());
}

/** D15: GitHub auto-merge, never a merge. */
async function enableAutoMerge(
  ctx: JobContext,
  gh: GitHubClient,
  data: RevertData,
  pr: { number: number; nodeId: string },
  mergeMethod: MergeMethod,
): Promise<"enabled" | "unavailable"> {
  let res: unknown;
  try {
    res = await gh.graphql(ENABLE_AUTO_MERGE_MUTATION, {
      pullRequestId: pr.nodeId,
      mergeMethod,
      clientMutationId: `graft-guard:${data.owner}/${data.repo}#${pr.number}`,
    });
  } catch (err) {
    if (err instanceof MutationRefusedError) throw err;
    const errors = (err as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      const types = errors.map((x) =>
        String((x as { type?: unknown }).type ?? "unknown").slice(0, 40),
      );
      const already = errors.some((x) =>
        /already enabled/i.test(String((x as { message?: unknown }).message ?? "")),
      );
      ctx.log.info(
        { prNumber: pr.number, types, already },
        "guard auto-merge not enabled by GitHub",
      );
      return already ? "enabled" : "unavailable";
    }
    throw toJobError(err, "graphql enablePullRequestAutoMerge");
  }
  const out = (
    res as {
      enablePullRequestAutoMerge?: {
        pullRequest?: { number?: unknown; repository?: { nameWithOwner?: unknown } };
      } | null;
    } | null
  )?.enablePullRequestAutoMerge?.pullRequest;
  const name = String(out?.repository?.nameWithOwner ?? "").toLowerCase();
  if (out?.number !== pr.number || name !== `${data.owner}/${data.repo}`.toLowerCase()) {
    throw new PermanentJobError(
      "auto-merge answered for another pull request",
      "auto_merge_mismatch",
    );
  }
  return "enabled";
}

// ---------------------------------------------------------------------------------------------
// The comment (step 10)
// ---------------------------------------------------------------------------------------------

function autoMergeView(e: GuardEventRow, risk?: RiskClass): AutoMergeView {
  if (e.auto_merge_state === "enabled") return { on: true, risk };
  if (e.auto_merge_state === "would" && e.auto_merge_reason === null) return { on: true, risk };
  if (e.auto_merge_state === "unavailable") return { on: false, reason: "unavailable" };
  return { on: false, reason: (e.auto_merge_reason ?? "opened") as AutoMergeReason };
}

/** §10 from the stored outcome; `extras` are what only this run knows (the conflicting paths). */
function sectionOf(
  e: GuardEventRow,
  extras: { conflicts?: readonly string[]; restoredTo?: string | null } = {},
): RevertSection {
  switch (e.revert_outcome) {
    case "planned":
      return {
        kind: "planned",
        paths: e.revert_plan_paths ?? 0,
        restoredTo: extras.restoredTo ?? e.last_green_sha ?? e.failing_sha,
        autoMerge: autoMergeView(e),
      };
    case "opened":
      return { kind: "opened", prNumber: e.revert_pr_number ?? 0, autoMerge: autoMergeView(e) };
    case "needs_human":
      return {
        kind: "needs_human",
        reason: (e.revert_reason ?? "too_large") as NeedsHumanReason,
        branch: e.branch,
        conflicts: extras.conflicts ?? null,
        conflictCount: e.revert_conflicts ?? 0,
      };
    case "skipped":
      return e.revert_reason === "revert_off"
        ? { kind: "step4" }
        : { kind: "skipped", reason: (e.revert_reason ?? "revert_off") as SkipReason };
    default:
      return {
        kind: "error",
        errorClass: e.revert_reason ?? "github_error",
        prNumber: e.revert_pr_number,
      };
  }
}

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

export async function runRevert(
  data: RevertData,
  ctx: JobContext,
  o: { octokit?: GitHubClient; guardOctokit?: GitHubClient } = {},
): Promise<RevertRun> {
  // 1.
  if (!ctx.config.guardDetection) return "disabled";
  if (!(await getActiveInstallation(ctx.db, data.installationId))) return "inactive";
  const repository = await getActiveRepository(ctx.db, data.repositoryId);
  if (!repository || repository.installation_id !== data.installationId) return "inactive";
  // 2.
  const first = await getEvent(ctx.db, data.eventId);
  if (
    first === undefined ||
    first.repository_id !== data.repositoryId ||
    first.comment_id !== null ||
    first.culprit_change_id === null ||
    !COMMENTED_STATUSES.includes(first.status)
  ) {
    return "stopped";
  }
  const event: GuardEventRow = first;
  const changeId = event.culprit_change_id as string;
  const change = await getChange(ctx.db, changeId);
  if (!change || change.repository_id !== data.repositoryId) return "stopped";

  // 3. D2: the modes, once; the mutation guard reads them again at every write.
  const guardMode: ModeState<"report" | "enforce"> = (
    await getEffectiveModes(ctx.db, data.repositoryId, ctx.config)
  ).guard;
  const now = () => ctx.clock.now();
  await updateEvent(ctx.db, event.id, { guardMode: guardMode.effective }, now());
  let octokit: GitHubClient;
  try {
    octokit = o.octokit ?? (await ctx.github.forInstallation(data.installationId));
  } catch (err) {
    throw toJobError(err, "installation token");
  }
  const comment = async (extras: Parameters<typeof sectionOf>[1] = {}): Promise<RevertRun> => {
    const row = (await getEvent(ctx.db, event.id)) as GuardEventRow;
    await publishGuardComment(event.id, ctx, {
      octokit,
      section: sectionOf(row, extras),
      mode: modeFor(row, guardMode),
    });
    return "commented";
  };
  const settle = async (
    outcome: "planned" | "needs_human" | "skipped" | "error",
    reason: string | null,
    more: Parameters<typeof updateEvent>[2] = {},
  ): Promise<void> => {
    await updateEvent(
      ctx.db,
      event.id,
      {
        revertOutcome: outcome,
        revertReason: reason,
        ...(outcome === "needs_human" ? { status: "needs_human" as const } : {}),
        ...more,
      },
      now(),
    );
    ctx.log.info({ eventId: event.id, outcome, reason }, "guard revert settled");
  };
  /** A failure in steps 5-9: retried while the queue can, then stored as `error`. */
  const failed = async (err: unknown): Promise<RevertRun> => {
    if (err instanceof MutationRefusedError) {
      await settle("error", refusalClass(err));
      return comment();
    }
    if (isRetryable(err) && canRetry(ctx)) throw err;
    // D4: writes began; adopt the PR or, for a retryable error on the last attempt, leave the
    // event resumable. No comment: a written comment would stop the resumed run (it writes the
    // comment as its last step). A permanent error with no PR found settles `error` below.
    if ((await settleBegunWrites(ctx, data, octokit, err)) !== null) return "stopped";
    await settle("error", errorClass(err));
    return comment();
  };

  // A stored outcome: only the comment is left, or the label and auto-merge of an opened revert.
  if (event.revert_outcome !== null) {
    const unfinished =
      event.revert_outcome === "opened" &&
      (!event.revert_labelled || event.auto_merge_state === null);
    if (!unfinished) return comment();
  }

  // 3. D19.
  if (event.revert_outcome === null && !ctx.config.guardRevert) {
    await settle("skipped", "revert_off");
    return comment();
  }
  // 4. D3, D4.
  if (event.revert_outcome === null) {
    if (event.status !== "culprit_found") return "stopped";
    if (event.confirm_reason === "off") {
      await settle("skipped", "confirmation_off");
      return comment();
    }
    if (event.confirm_reason !== "next_commit" && event.confirm_reason !== "window")
      return "stopped";
    if (await eventByRevertPr(ctx.db, data.repositoryId, change.pr_number)) {
      await settle("skipped", "revert_of_revert");
      return comment();
    }
    // Step 5 review 1, finding 4: a revert never opens days late (a job sent again long after
    // its event). An event whose writes began is resumed whatever its age.
    if (
      event.revert_commit_sha === null &&
      event.revert_branch === null &&
      isStale(event, now(), ctx.config.guardRevertMaxAgeHours)
    ) {
      await settle("skipped", "stale");
      return comment();
    }
  }

  // 5. The plan: GETs only, outside every lock.
  const reader = apiTreeReader(octokit, {
    owner: data.owner,
    repo: data.repo,
    maxTreeReads: 2 * ctx.config.guardRevertMaxTreeReads + 10,
  });
  const limits = {
    maxPaths: ctx.config.guardRevertMaxPaths,
    maxTreeReads: ctx.config.guardRevertMaxTreeReads,
  };
  let g: Gathered;
  let plan: Plan;
  let facts: Awaited<ReturnType<typeof culpritFacts>>;
  try {
    const got = await gather(ctx, octokit, reader, data, event, change);
    if ("kind" in got) {
      if (event.revert_outcome !== null) return comment();
      await settle(got.kind, got.reason, {
        revertConflicts: got.kind === "needs_human" ? 0 : null,
      });
      return comment();
    }
    g = got;
    facts = await culpritFacts(ctx, changeId, g.culprit.mergedHead);
    if (event.revert_outcome === "opened") {
      // Resuming the label or auto-merge of an opened revert: only the policy-file test of the
      // culprit's own diff is needed, whatever the tip is now.
      const changes = await diffTrees(reader, g.baseTree, g.headTree, limits);
      plan = {
        kind: "revert",
        changes: Array.isArray(changes) ? changes : [],
        touchesPolicyFile:
          !Array.isArray(changes) ||
          changes.some((c) => POLICY_PATHS.some((p) => p === c.path || p.startsWith(`${c.path}/`))),
      };
    } else {
      plan = await planRevert(
        reader,
        {
          baseTree: g.baseTree,
          headTree: g.headTree,
          tipTree: g.tip.tree,
          policyPaths: POLICY_PATHS,
        },
        limits,
      );
    }
  } catch (err) {
    return failed(err);
  }
  ctx.log.info(
    {
      eventId: event.id,
      plan: plan.kind,
      paths: plan.kind === "revert" ? plan.changes.length : 0,
      treeReads: reader.treeRequests(),
    },
    "guard revert planned",
  );

  if (event.revert_outcome === null) {
    if (plan.kind === "needs_human") {
      await settle("needs_human", plan.reason, { revertConflicts: plan.conflicts.length });
      return comment({ conflicts: plan.reason === "touched_later" ? plan.conflicts : [] });
    }
    if (plan.kind === "skipped") {
      await settle("skipped", plan.reason);
      return comment();
    }
    await updateEvent(
      ctx.db,
      event.id,
      { revertPlanPaths: plan.changes.length, revertConflicts: 0 },
      now(),
    );
  }
  if (plan.kind !== "revert") return comment();
  const elig = eligibility(g, facts, plan.touchesPolicyFile);

  // 6. Report mode stops here. No guard client is ever made in report mode.
  if (guardMode.effective !== "enforce") {
    // An opened revert whose label or auto-merge is left, after a rollback to report: those
    // writes would be refused, so the run ends as the refusal would (§7, step 9).
    if (event.revert_outcome !== null) {
      await settle("error", "mode_changed");
      return comment({ restoredTo: g.range.base });
    }
    // Step 5 review 1, finding 6: an enforce run began writing, then the repository went back to
    // report. What GitHub holds is never a plan: a PR from the branch is adopted (a GET with the
    // default client), and the event ends `error mode_changed` either way.
    if (event.revert_commit_sha !== null || event.revert_branch !== null) {
      try {
        const found = await findPr(octokit, { data, eventId: event.id });
        if (found)
          await storePr(ctx, { eventId: event.id, changeId }, found, revertBranch(event.id));
      } catch (err) {
        return failed(err);
      }
      await settle("error", "mode_changed");
      return comment({ restoredTo: g.range.base });
    }
    await settle("planned", null, {
      autoMergeState: "would",
      autoMergeReason: elig.eligible ? null : elig.reason,
    });
    return comment({ restoredTo: g.range.base });
  }

  // 7. The claim, under the repository lock (database only).
  if (event.revert_outcome === null) {
    const remainingKeys = g.remaining.map((c) => c.key);
    const claim = await withRepositoryGuardLock(ctx.db, data.repositoryId, async (tx) => {
      const locked = await getEventForUpdate(tx, event.id);
      if (locked?.status !== "culprit_found" || locked.revert_outcome !== null)
        return "gone" as const;
      if (locked.revert_claimed_at === null) {
        if (
          (await countOpenReverts(tx, data.repositoryId, event.id)) >=
          ctx.config.guardMaxOpenReverts
        ) {
          return "cap_reached" as const;
        }
        if (await otherRevertOfCulprit(tx, data.repositoryId, changeId, event.id)) {
          return "already_opened" as const;
        }
      }
      // D21: someone fixed forward.
      const failing = await getMainCommit(tx, data.repositoryId, event.failing_sha);
      if (failing) {
        const later = await tx
          .selectFrom("main_commits")
          .select("sha")
          .where("repository_id", "=", data.repositoryId)
          .where("seq", ">", failing.seq)
          .execute();
        const rows = await resultsAt(
          tx,
          data.repositoryId,
          later.map((r) => r.sha),
          remainingKeys,
        );
        const greenAt = new Map<string, number>();
        for (const r of rows) {
          if (r.class === "green") greenAt.set(r.sha, (greenAt.get(r.sha) ?? 0) + 1);
        }
        if ([...greenAt.values()].some((n) => n >= remainingKeys.length)) {
          return "already_green" as const;
        }
      }
      if (locked.revert_claimed_at === null) {
        await updateEvent(tx, event.id, { revertClaimedAt: ctx.clock.now() }, ctx.clock.now());
      }
      return "claimed" as const;
    });
    if (claim === "gone") return "stopped";
    if (claim !== "claimed") {
      await settle("skipped", claim);
      return comment();
    }
  }

  // 8. The writes, through the only guard client of the codebase.
  let pr: { number: number; nodeId: string };
  try {
    const gh =
      o.guardOctokit ??
      (await ctx.github.forInstallation(data.installationId, { feature: "guard" }));
    const failingCommit = await getMainCommit(ctx.db, data.repositoryId, event.failing_sha);
    const next = await childOf(ctx.db, data.repositoryId, event.failing_sha);
    const results = new Map(
      (
        await resultsAt(
          ctx.db,
          data.repositoryId,
          [event.failing_sha],
          g.remaining.map((c) => c.key),
        )
      ).map((r) => [r.key, r] as const),
    );
    const webBase = githubWebBase(ctx.config.githubApiUrl);
    const body = revertBody({
      prNumber: change.pr_number,
      branch: event.branch,
      failingSha: event.failing_sha,
      lastGreenSha: event.last_green_sha ?? g.range.base,
      lastGreenIsParent:
        event.last_green_sha !== null && failingCommit?.parent_sha === event.last_green_sha,
      restoredTo: g.range.base,
      paths: plan.changes.length,
      checks: g.remaining.map((c) => {
        const url = results.get(c.key)?.html_url ?? null;
        return { name: c.name, htmlUrl: url?.startsWith(webBase) ? url : null };
      }),
      confirmation:
        event.confirm_reason === "next_commit" && next
          ? { reason: "next_commit", nextSha: next.sha }
          : { reason: "window", windowSeconds: ctx.config.guardConfirmSeconds },
      author: g.culprit.author,
      mergedBy: g.culprit.mergedBy,
      task: facts.task,
      sessionUrl: facts.sessionUrl,
      autoMerge: elig.eligible ? { on: true, risk: elig.risk } : { on: false, reason: elig.reason },
    });
    pr = await openRevert(ctx, gh, {
      data,
      eventId: event.id,
      changeId,
      defaultBranch: g.repo.defaultBranch,
      tip: g.tip,
      changes: plan.changes,
      reader,
      message: revertCommitMessage({
        prNumber: change.pr_number,
        branch: event.branch,
        failingSha: event.failing_sha,
        restoredTo: g.range.base,
        paths: plan.changes.length,
      }),
      title: revertTitle(change.pr_number),
      body,
    });
    const row = (await getEvent(ctx.db, event.id)) as GuardEventRow;
    if (!row.revert_labelled) await labelRevert(ctx, gh, data, event.id, pr.number);

    // 9. Auto-merge.
    if (row.auto_merge_state === null) {
      if (!elig.eligible) {
        await updateEvent(
          ctx.db,
          event.id,
          { autoMergeState: "not_eligible", autoMergeReason: elig.reason },
          now(),
        );
      } else {
        const state = await enableAutoMerge(ctx, gh, data, pr, g.repo.mergeMethod as MergeMethod);
        await updateEvent(
          ctx.db,
          event.id,
          { autoMergeState: state, autoMergeReason: null },
          now(),
        );
      }
    }
  } catch (err) {
    return failed(err);
  }
  // 10.
  return comment({ restoredTo: g.range.base });
}

/**
 * Step 5 review 1, finding 4: the last attempt of a run that failed outside `failed()` (the
 * installation token, the modes, the claim, the comment itself). An event with no outcome gets
 * `error` with the failure's class, which releases a claimed cap slot, and the comment is tried
 * once. Best effort: a second failure is logged, and the job still fails.
 */
export async function settleFailedRun(
  data: RevertData,
  ctx: JobContext,
  err: unknown,
): Promise<void> {
  try {
    const e = await getEvent(ctx.db, data.eventId);
    if (
      e === undefined ||
      e.repository_id !== data.repositoryId ||
      e.comment_id !== null ||
      e.culprit_change_id === null ||
      !COMMENTED_STATUSES.includes(e.status)
    ) {
      return;
    }
    // D4: a run whose writes began is adopted, or left resumable when its error is retryable.
    // A permanent error with no PR found is settled `error` below (step 7 review 1, finding 1).
    if ((await settleBegunWrites(ctx, data, null, err)) !== null) return;
    if (e.revert_outcome === null) {
      await updateEvent(
        ctx.db,
        e.id,
        { revertOutcome: "error", revertReason: errorClass(err) },
        ctx.clock.now(),
      );
      ctx.log.info(
        { eventId: e.id, outcome: "error", reason: errorClass(err) },
        "guard revert settled after its last attempt",
      );
    }
    const row = (await getEvent(ctx.db, e.id)) as GuardEventRow;
    const guardMode = (await getEffectiveModes(ctx.db, data.repositoryId, ctx.config)).guard;
    await publishGuardComment(e.id, ctx, {
      section: sectionOf(row),
      mode: modeFor(row, guardMode as ModeState<"report" | "enforce">),
    });
  } catch (again) {
    ctx.log.warn(
      { eventId: data.eventId, errorClass: errorClass(again) },
      "guard revert could not be settled after its last attempt",
    );
  }
}

export const guardRevertJob = defineJob<RevertData>({
  name: REVERT_JOB,
  schema: revertSchema,
  // Step 5 review 1, finding 4: the job row (and with it the singleton id of D1) is kept one hour
  // after the job ends, not 7 days, so a later observe can send a failed run again. The database
  // state, not the job row, is what makes a revert happen once.
  options: { retryLimit: 3, deleteAfterSeconds: 3600 },
  async handle(data, ctx) {
    let outcome: RevertRun;
    try {
      outcome = await runRevert(data, ctx);
    } catch (err) {
      if (!isRetryable(err) || !canRetry(ctx)) await settleFailedRun(data, ctx, err);
      throw err;
    }
    ctx.log.info({ eventId: data.eventId, outcome }, "guard revert done");
  },
});

/** D1: enqueues `guard.revert` for one event (one per event, whatever the triggers). */
export async function scheduleRevert(
  ctx: Pick<JobContext, "queue">,
  data: RevertData,
): Promise<string | null> {
  return ctx.queue.send(guardRevertJob, data, { singletonKey: revertKey(data.eventId) });
}
