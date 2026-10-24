/**
 * `guard.observe` and `guard.confirm` (Phase 1 step 4, §6, §7). The job reads CI results for one
 * default-branch commit from the API (never from the payload that triggered it), stores one class
 * per check, and runs detection and confirmation under the per-repository advisory lock. No GitHub
 * call is made inside that lock. Since Phase 1 step 5 (D1), an event that reaches `culprit_found`
 * is handed to `guard.revert` after the lock is released; that job plans the revert and writes the
 * comment (lock order: repository lock, released, then change lock; never both).
 */
import type { Transaction } from "kysely";
import type { JobContext } from "../../core/context.js";
import type { Database, GuardCandidate, GuardFailingCheck } from "../../db/schema.js";
import type { GitHubClient } from "../../github/client-factory.js";
import { classifyGitHubError, toJobError } from "../../github/errors.js";
import {
  allowedByGuardChecks,
  type ChainCommit,
  type Classification,
  checkName,
  checkRunKey,
  classifyCandidates,
  classifyConclusion,
  classifyStatusState,
  confirmationDetail,
  detectTransition,
  type ResultClass,
  statusKey,
  type Transition,
} from "../../guard/detect.js";
import { hasStatusesRead } from "../../modes/index.js";
import { loadBasePolicy } from "../../policy/load.js";
import { PermanentJobError } from "../../queue/errors.js";
import { defineJob } from "../../queue/job.js";
import { getActiveInstallation, getActiveRepository } from "../installations/index.js";
import { getRepositoryModeRow, modesOf } from "../modes/index.js";
import { githubWebBase, safeHtmlUrl } from "./comment.js";
import { scheduleRevert } from "./revert.js";
import {
  type ConfirmData,
  confirmKey,
  confirmSchema,
  type ObserveData,
  observeKey,
  observeSchema,
} from "./schemas.js";
import {
  childOf,
  eventAt,
  eventsAwaitingComment,
  type GuardEventRow,
  getEvent,
  getMainCommit,
  insertEvent,
  lineTo,
  MAX_CANDIDATES,
  MAX_FAILING_CHECKS,
  type ObservedResult,
  openEvents,
  resultsAt,
  toChainCommit,
  updateEvent,
  upsertResults,
  withRepositoryGuardLock,
} from "./store.js";
import { readDefaultBranch, trackDefaultBranch } from "./track.js";

export const OBSERVE_JOB = "guard.observe";
export const CONFIRM_JOB = "guard.confirm";
const RUN_PAGES = 5;
const STATUS_PAGES = 3;
/** `guard.confirm` runs this long after the deadline (step 4 review 1, finding 4). */
export const CONFIRM_MARGIN_SECONDS = 60;
/** An event still undecided at the deadline is examined again this many times, a window apart. */
export const CONFIRM_RETRIES = 2;

export type ObserveOutcome = "disabled" | "inactive" | "not_on_default_branch" | "observed";

// ---------------------------------------------------------------------------------------------
// Reading results (§6.2)
// ---------------------------------------------------------------------------------------------

async function readCheckRuns(
  octokit: GitHubClient,
  ctx: JobContext,
  o: { owner: string; repo: string; sha: string },
  webBase: string,
): Promise<ObservedResult[]> {
  // key -> check suite -> the latest result of that key in that suite.
  const byKey = new Map<string, Map<number | null, ObservedResult>>();
  let complete = false;
  for (let page = 1; page <= RUN_PAGES; page++) {
    let data: Awaited<ReturnType<GitHubClient["rest"]["checks"]["listForRef"]>>["data"];
    try {
      data = (
        await octokit.rest.checks.listForRef({
          owner: o.owner,
          repo: o.repo,
          ref: o.sha,
          // Every run, not `latest` (the most recent run per name and app): a later green run
          // of the same name in another check suite would otherwise hide the red one before the
          // reduction below sees it (step 4 review 2, finding B).
          filter: "all",
          per_page: 100,
          page,
        })
      ).data;
    } catch (err) {
      throw toJobError(err, "checks.listForRef");
    }
    for (const run of data.check_runs) {
      const appId = run.app?.id;
      // Graft's own checks never count (D1).
      if (typeof appId !== "number" || appId === ctx.config.githubAppId) continue;
      if (run.head_sha !== o.sha) continue;
      const key = checkRunKey(appId, run.name);
      const completedAt = run.completed_at ? new Date(run.completed_at) : null;
      const result: ObservedResult = {
        key,
        name: checkName(run.name),
        source: "check_run",
        class: run.status === "completed" ? classifyConclusion(run.conclusion) : "ignored",
        filtered: false,
        htmlUrl: safeHtmlUrl(run.html_url, webBase),
        completedAt,
      };
      // D4: two runs with one key in one check suite (a re-run), the latest `completed_at` wins.
      const suite = typeof run.check_suite?.id === "number" ? run.check_suite.id : null;
      const suites = byKey.get(key) ?? new Map<number | null, ObservedResult>();
      byKey.set(key, suites);
      const prev = suites.get(suite);
      if (!prev || isLater(result, prev)) suites.set(suite, result);
    }
    if (data.check_runs.length < 100 || page * 100 >= data.total_count) {
      complete = true;
      break;
    }
  }
  const results = [...byKey.values()].map((suites) => {
    // Step 4 review 1, finding 7: one key in several check suites (a second workflow with a job
    // of the same name) is not a re-run. Red wins there, so a later green decoy in another suite
    // cannot hide a failure; otherwise the latest result wins as in D4.
    const all = [...suites.values()];
    const red = all.filter((r) => r.class === "red");
    const pool = red.length > 0 ? red : all;
    return pool.reduce((best, r) => (isLater(r, best) ? r : best));
  });
  if (complete) return results;
  // More runs than the pages read (re-runs count with `filter: "all"`). A run left unread may be
  // the red one that wins across suites, or a later re-run in the same suite, so no result read
  // here can be trusted as green or as red: every key is `ignored` on this commit, which can widen
  // a later event's candidates or miss this commit's failure, never blame the wrong PR (PR #30).
  ctx.log.warn(
    { sha: o.sha, read: RUN_PAGES * 100 },
    "guard check runs truncated; the commit's results are ignored",
  );
  return results.map((r) => ({ ...r, class: "ignored" }));
}

/** D4: `a` replaces `b` when it completed strictly later (a run not completed never replaces). */
function isLater(a: ObservedResult, b: ObservedResult): boolean {
  return (
    a.completedAt !== null &&
    (b.completedAt === null || a.completedAt.getTime() > b.completedAt.getTime())
  );
}

async function readStatuses(
  octokit: GitHubClient,
  o: { owner: string; repo: string; sha: string },
  webBase: string,
): Promise<ObservedResult[]> {
  const byKey = new Map<string, ObservedResult>();
  for (let page = 1; page <= STATUS_PAGES; page++) {
    let data: Awaited<ReturnType<GitHubClient["rest"]["repos"]["getCombinedStatusForRef"]>>["data"];
    try {
      data = (
        await octokit.rest.repos.getCombinedStatusForRef({
          owner: o.owner,
          repo: o.repo,
          ref: o.sha,
          per_page: 100,
          page,
        })
      ).data;
    } catch (err) {
      if (classifyGitHubError(err) === "not_found") return [...byKey.values()];
      throw toJobError(err, "repos.getCombinedStatusForRef");
    }
    for (const s of data.statuses) {
      const key = statusKey(s.context);
      const at = s.updated_at ? new Date(s.updated_at) : null;
      const prev = byKey.get(key);
      if (prev && prev.completedAt !== null && at !== null && prev.completedAt >= at) continue;
      byKey.set(key, {
        key,
        name: checkName(s.context),
        source: "status",
        class: classifyStatusState(s.state),
        filtered: false,
        // Whoever posts a status chooses its link: only a page of this repository is kept (step 4
        // review 1, nit 9). Check-run links come from GitHub and keep the web root rule.
        htmlUrl: safeHtmlUrl(s.target_url, `${webBase}${o.owner}/${o.repo}/`),
        // A pending status is not a result yet; it never replaces one.
        completedAt: s.state === "pending" ? null : at,
      });
    }
    if (data.statuses.length < 100) break;
  }
  return [...byKey.values()];
}

/**
 * D17: `guard.checks` of `graft.yaml` at a commit (the baseline of a transition); null means every
 * key, which is also the answer for a missing or invalid file (fail toward detecting).
 */
async function guardChecksAt(
  octokit: GitHubClient,
  o: { repositoryId: number; owner: string; repo: string; sha: string },
): Promise<Set<string> | null> {
  try {
    const loaded = await loadBasePolicy(octokit, {
      repositoryId: o.repositoryId,
      owner: o.owner,
      repo: o.repo,
      commitSha: o.sha,
    });
    if (loaded.status !== "ok" || loaded.policy.guard?.checks === undefined) return null;
    return new Set(loaded.policy.guard.checks);
  } catch (err) {
    // A file Graft cannot use means "every key"; a transient failure is retried.
    if (err instanceof PermanentJobError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Detection and confirmation (§7), inside the repository lock
// ---------------------------------------------------------------------------------------------

function storedCandidates(chain: readonly ChainCommit[]): GuardCandidate[] {
  const list: GuardCandidate[] = chain.map((c) => ({
    sha: c.sha,
    prNumber: c.pr.kind === "pr" ? c.pr.number : null,
    kind: c.pr.kind,
  }));
  if (list.length <= MAX_CANDIDATES) return list;
  // The newest candidates are kept; the cut is recorded as one unresolved entry, so a list that
  // could not be stored in full is never read back as a culprit.
  const kept = list.slice(list.length - (MAX_CANDIDATES - 1));
  return [{ sha: (list[0] as GuardCandidate).sha, prNumber: null, kind: "truncated" }, ...kept];
}

/** The classification of stored candidates (a `truncated` entry counts as unresolved). */
export function classifyStored(candidates: readonly GuardCandidate[]): Classification {
  return classifyCandidates(
    candidates.map((c, i) => ({
      sha: c.sha,
      seq: i,
      chainBreak: false,
      pr:
        c.kind === "pr" && c.prNumber !== null
          ? { kind: "pr", number: c.prNumber }
          : c.kind === "direct"
            ? { kind: "direct" }
            : c.kind === "multiple"
              ? { kind: "multiple" }
              : { kind: "unresolved" },
    })),
  );
}

async function culpritChangeId(
  tx: Transaction<Database>,
  repositoryId: number,
  candidates: readonly ChainCommit[],
  prNumber: number,
): Promise<string | null> {
  const rows = await tx
    .selectFrom("main_commits")
    .select("change_id")
    .where("repository_id", "=", repositoryId)
    .where(
      "sha",
      "in",
      candidates.map((c) => c.sha),
    )
    .where("change_id", "is not", null)
    .execute();
  const fromCommit = rows.find((r) => r.change_id !== null)?.change_id ?? null;
  if (fromCommit !== null) return fromCommit;
  const change = await tx
    .selectFrom("changes")
    .select("id")
    .where("repository_id", "=", repositoryId)
    .where("pr_number", "=", prNumber)
    .executeTakeFirst();
  return change?.id ?? null;
}

type NewTransition = Extract<Transition, { kind: "new" }>;

interface DetectContext {
  tx: Transaction<Database>;
  ctx: JobContext;
  repositoryId: number;
  branch: string;
  now: Date;
  /** The event whose last `guard.confirm` attempt this is: still undecided, it settles (finding 4). */
  finalEventId?: string | undefined;
  /**
   * Phase 1 step 7 (D13): the effective guard mode, read once per run before the lock. Stored on
   * every event this run settles, when the event has none yet.
   */
  guardMode: "report" | "enforce";
}

/** Opens an event for a new transition, or adds the key to the event it belongs to (D8). */
async function recordTransition(
  d: DetectContext,
  t: NewTransition,
  check: GuardFailingCheck,
  htmlUrl: string | null,
): Promise<string | null> {
  const { tx, repositoryId, now } = d;
  const addKey = async (e: GuardEventRow): Promise<void> => {
    if (e.failing_checks.some((c) => c.key === check.key)) return;
    if (e.failing_checks.length >= MAX_FAILING_CHECKS) return;
    await updateEvent(tx, e.id, { failingChecks: [...e.failing_checks, check] }, now);
  };
  const classification = classifyCandidates(t.candidates);
  const candidates = storedCandidates(t.candidates);

  // D8: one event per failing commit.
  const same = await eventAt(tx, repositoryId, t.failingSha);
  if (same) {
    if (same.status === "confirming") await addKey(same);
    return null;
  }
  const open = await openEvents(tx, repositoryId);
  // The same transition seen late: an open event for this key whose candidates include this
  // commit was opened while this commit had no result yet. It moves to this commit.
  const earlier = open.find(
    (e) =>
      e.failing_checks.some((c) => c.key === check.key) &&
      e.candidates.some((c) => c.sha === t.failingSha),
  );
  if (earlier) {
    await updateEvent(
      tx,
      earlier.id,
      {
        failingSha: t.failingSha,
        lastGreenSha: t.lastGreenSha,
        candidates,
        ciRunUrl: htmlUrl ?? earlier.ci_run_url,
        culpritChangeId:
          classification.status === "culprit_found"
            ? await culpritChangeId(tx, repositoryId, t.candidates, classification.prNumber)
            : null,
      },
      now,
    );
    d.ctx.log.info({ eventId: earlier.id }, "guard event moved to the earlier failing commit");
    return null;
  }
  // D8: a key that goes red later while an event is open for the same culprit joins that event.
  if (classification.status === "culprit_found") {
    const sameCulprit = open.find((e) => {
      const c = classifyStored(e.candidates);
      return c.status === "culprit_found" && c.prNumber === classification.prNumber;
    });
    if (sameCulprit) {
      await addKey(sameCulprit);
      return null;
    }
  }
  const confirm = d.ctx.config.guardConfirm;
  const event = await insertEvent(tx, {
    repositoryId,
    branch: d.branch,
    failingSha: t.failingSha,
    lastGreenSha: t.lastGreenSha,
    failingChecks: [check],
    candidates,
    ciRunUrl: htmlUrl,
    culpritChangeId:
      classification.status === "culprit_found"
        ? await culpritChangeId(tx, repositoryId, t.candidates, classification.prNumber)
        : null,
    // D9: with confirmation on the outcome waits; off, it is final now.
    status: confirm ? "confirming" : classification.status,
    detectedAt: now,
    confirmedAt: confirm ? null : now,
    confirmReason: confirm ? null : "off",
  });
  // D13: with confirmation off the event is settled at once, so it records its mode now.
  if (!confirm) await updateEvent(tx, event.id, { guardMode: d.guardMode }, now);
  d.ctx.log.info(
    { eventId: event.id, status: event.status, candidates: t.candidates.length },
    "guard event opened",
  );
  if (confirm) {
    await d.ctx.queue.send(
      guardConfirmJob,
      { eventId: event.id },
      {
        tx,
        singletonKey: confirmKey(event.id, 0),
        // A margin past the deadline, so a worker whose clock is a little behind still sees the
        // window as elapsed (step 4 review 1, finding 4).
        startAfterSeconds: d.ctx.config.guardConfirmSeconds + CONFIRM_MARGIN_SECONDS,
      },
    );
  }
  return event.id;
}

/**
 * Step 4 review 1, finding 2: a later green on a commit between the event's last green commit and
 * its failing commit (the parent's CI finished after the child was observed) narrows the event to
 * the commits after that green. Each failing key is judged again on the current line; the event
 * narrows only when every key still has a transition at the failing commit, and to the widest of
 * them, whose last green commit must be one of the event's candidates. Only `confirming` events
 * are passed here.
 */
async function narrowEvent(d: DetectContext, e: GuardEventRow): Promise<GuardEventRow> {
  const { tx, repositoryId, now } = d;
  const keys = e.failing_checks.map((c) => c.key);
  if (keys.length === 0) return e;
  const chain = (await lineTo(tx, repositoryId, e.failing_sha)).map(toChainCommit);
  const results = (
    await resultsAt(
      tx,
      repositoryId,
      chain.map((c) => c.sha),
      keys,
    )
  ).map((r) => ({ key: r.key, sha: r.sha, class: r.class }));
  let widest: NewTransition | null = null;
  for (const key of keys) {
    const t = detectTransition(chain, results, key, e.failing_sha);
    if (t.kind !== "new") return e;
    if (widest === null || t.candidates.length > widest.candidates.length) widest = t;
  }
  if (widest === null || widest.lastGreenSha === e.last_green_sha) return e;
  const lastGreenSha = widest.lastGreenSha;
  if (!e.candidates.some((c) => c.sha === lastGreenSha)) return e;
  const candidates = storedCandidates(widest.candidates);
  const classification = classifyCandidates(widest.candidates);
  const culprit =
    classification.status === "culprit_found"
      ? await culpritChangeId(tx, repositoryId, widest.candidates, classification.prNumber)
      : null;
  await updateEvent(tx, e.id, { lastGreenSha, candidates, culpritChangeId: culprit }, now);
  d.ctx.log.info(
    { eventId: e.id, candidates: widest.candidates.length },
    "guard event narrowed to a later green commit",
  );
  return { ...e, last_green_sha: lastGreenSha, candidates, culprit_change_id: culprit };
}

/** D9 for every open event of the repository. Returns the events that became `culprit_found`. */
async function confirmOpenEvents(d: DetectContext): Promise<string[]> {
  const { tx, repositoryId, now } = d;
  const reached: string[] = [];
  for (const open of await openEvents(tx, repositoryId)) {
    const e = await narrowEvent(d, open);
    const keys = e.failing_checks.map((c) => c.key);
    const next = await childOf(tx, repositoryId, e.failing_sha);
    const shas = next ? [e.failing_sha, next.sha] : [e.failing_sha];
    const rows = await resultsAt(tx, repositoryId, shas, keys);
    const on = (sha: string): Record<string, ResultClass> =>
      Object.fromEntries(rows.filter((r) => r.sha === sha).map((r) => [r.key, r.class]));
    const step = confirmationDetail({
      failingKeys: keys,
      failingSha: e.failing_sha,
      nextSha: next?.sha ?? null,
      resultsOnFailing: on(e.failing_sha),
      resultsOnNext: next ? on(next.sha) : {},
      detectedAt: e.detected_at ?? e.created_at,
      now,
      windowSeconds: d.ctx.config.guardConfirmSeconds,
    });
    if (step.step === "wait" && e.id !== d.finalEventId) continue;
    // The last confirm attempt of an event still undecided (its failing result is no longer red
    // and not green: a cancelled re-run, say): the failure did not persist, so it is not
    // confirmed. It settles `flaky` with no reason rather than staying open for good.
    const status = step.step === "confirmed" ? classifyStored(e.candidates).status : "flaky";
    await updateEvent(
      tx,
      e.id,
      {
        status,
        confirmedAt: now,
        confirmReason: step.reason,
        // D13: the mode it settled under; a value `guard.revert` already stored is kept.
        ...(e.guard_mode === null ? { guardMode: d.guardMode } : {}),
      },
      now,
    );
    d.ctx.log.info({ eventId: e.id, status, reason: step.reason }, "guard event settled");
    if (status === "culprit_found") reached.push(e.id);
  }
  return reached;
}

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

/** Enqueues `guard.observe` for one commit (D12). */
export async function scheduleObserve(ctx: JobContext, data: ObserveData): Promise<string | null> {
  const delay = ctx.config.guardObserveDelaySeconds;
  const key = observeKey(data.repositoryId, data.sha, ctx.clock.now().getTime(), delay);
  return ctx.queue.send(guardObserveJob, data, {
    ...(key === undefined ? {} : { singletonKey: key }),
    ...(delay > 0 ? { startAfterSeconds: delay } : {}),
  });
}

/** Thrown out of the lock to roll back a pass that set a transition aside (finding 5). */
class BaselinesMissing extends Error {
  constructor(readonly shas: ReadonlySet<string>) {
    super("guard baselines not loaded");
  }
}

export async function observeCommit(
  data: ObserveData,
  ctx: JobContext,
  o: { octokit?: GitHubClient; finalEventId?: string } = {},
): Promise<ObserveOutcome> {
  if (!ctx.config.guardDetection) return "disabled";
  if (!(await getActiveInstallation(ctx.db, data.installationId))) return "inactive";
  const repository = await getActiveRepository(ctx.db, data.repositoryId);
  if (!repository || repository.installation_id !== data.installationId) return "inactive";
  let octokit: GitHubClient;
  try {
    octokit = o.octokit ?? (await ctx.github.forInstallation(data.installationId));
  } catch (err) {
    throw toJobError(err, "installation token");
  }

  // D13: a SHA the history does not know yet; track the default branch tip once, inline.
  let branch = repository.default_branch;
  if (!(await getMainCommit(ctx.db, data.repositoryId, data.sha))) {
    const defaultBranch = await readDefaultBranch(octokit, data, ctx);
    if (defaultBranch === null) return "inactive";
    branch = defaultBranch;
    let tip: string;
    try {
      tip = (
        await octokit.rest.git.getRef({
          owner: data.owner,
          repo: data.repo,
          ref: `heads/${defaultBranch}`,
        })
      ).data.object.sha;
    } catch (err) {
      throw toJobError(err, "git.getRef");
    }
    await trackDefaultBranch(
      { ...data, branch: defaultBranch, after: tip, before: null, forced: false },
      ctx,
      { enqueueObserve: false, octokit },
    );
    if (!(await getMainCommit(ctx.db, data.repositoryId, data.sha))) {
      ctx.log.info({ repositoryId: data.repositoryId }, "not_on_default_branch");
      return "not_on_default_branch";
    }
  }

  // §6.2: API reads, before the lock.
  const webBase = githubWebBase(ctx.config.githubApiUrl);
  const observed = await readCheckRuns(octokit, ctx, data, webBase);
  const modeRow = await getRepositoryModeRow(ctx.db, data.repositoryId);
  // Phase 1 step 7 (D13): read once per run, before the lock; an unknown row is report.
  const settledGuardMode: "report" | "enforce" =
    modeRow === undefined ? "report" : modesOf(modeRow, ctx.config.modeCeiling).guard.effective;
  if (hasStatusesRead(modeRow?.permissions)) {
    observed.push(...(await readStatuses(octokit, data, webBase)));
  }
  for (const r of observed) {
    ctx.log.debug({ key: r.key, class: r.class }, "guard result");
  }

  // D17, as corrected by the security review: results are stored unfiltered, and `guard.checks`
  // is read from the BASELINE (the last green commit before the candidates), never from the
  // failing commit, so a candidate cannot filter its own failure. The file is read through the
  // API, which never happens inside the lock: a transition whose baseline file is not loaded yet
  // is set aside, the file is loaded after the lock, and the lock phase runs again (bounded).
  const now = ctx.clock.now();
  const checksAt = new Map<string, Set<string> | null>();
  // The baselines are usually known before the lock: load their files up front (read-only
  // queries, then API reads, all outside the lock). The lock phase re-checks everything.
  const red0 = observed.filter((r) => r.class === "red");
  if (red0.length > 0) {
    const chain = (await lineTo(ctx.db, data.repositoryId, data.sha)).map(toChainCommit);
    const stored = (
      await resultsAt(
        ctx.db,
        data.repositoryId,
        chain.filter((c) => c.sha !== data.sha).map((c) => c.sha),
        red0.map((r) => r.key),
      )
    ).map((r) => ({ key: r.key, sha: r.sha, class: r.class }));
    const here = red0.map((r) => ({ key: r.key, sha: data.sha, class: r.class }));
    for (const r of red0) {
      const t = detectTransition(chain, [...stored, ...here], r.key, data.sha);
      if (t.kind === "new" && !checksAt.has(t.lastGreenSha)) {
        checksAt.set(
          t.lastGreenSha,
          await guardChecksAt(octokit, { ...data, sha: t.lastGreenSha }),
        );
      }
    }
  }
  const reached: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    let settled: string[];
    try {
      settled = await withRepositoryGuardLock(ctx.db, data.repositoryId, async (tx) => {
        const changed = await upsertResults(tx, data.repositoryId, data.sha, observed, now);
        // A pass that sets a transition aside rolls back (below), so every pass upserts the same
        // results and sees the same red keys, and so does a retry after a failure between passes
        // (step 4 review 1, finding 5).
        const red = observed.filter((r) => changed.includes(r.key) && r.class === "red");
        const d: DetectContext = {
          tx,
          ctx,
          repositoryId: data.repositoryId,
          branch: branch ?? "unknown",
          now,
          finalEventId: o.finalEventId,
          guardMode: settledGuardMode,
        };
        const missing = new Set<string>();
        if (red.length > 0) {
          const chain = (await lineTo(tx, data.repositoryId, data.sha)).map(toChainCommit);
          const results = (
            await resultsAt(
              tx,
              data.repositoryId,
              chain.map((c) => c.sha),
              red.map((r) => r.key),
            )
          ).map((r) => ({ key: r.key, sha: r.sha, class: r.class }));
          for (const r of red) {
            const t = detectTransition(chain, results, r.key, data.sha);
            if (t.kind === "none") {
              ctx.log.debug({ why: t.why }, "no guard transition");
              continue;
            }
            // The last pass treats a baseline still unknown (a race) as "every key".
            if (!checksAt.has(t.lastGreenSha) && attempt < 2) {
              missing.add(t.lastGreenSha);
              continue;
            }
            if (!allowedByGuardChecks(checksAt.get(t.lastGreenSha) ?? null, r.name)) {
              ctx.log.debug({ why: "filtered" }, "no guard transition");
              continue;
            }
            await recordTransition(d, t, { key: r.key, name: r.name, source: r.source }, r.htmlUrl);
          }
        }
        // Nothing of this pass is committed: the baselines are read outside the lock and the
        // pass runs again.
        if (missing.size > 0) throw new BaselinesMissing(missing);
        return confirmOpenEvents(d);
      });
    } catch (err) {
      if (!(err instanceof BaselinesMissing)) throw err;
      for (const sha of err.shas) {
        checksAt.set(sha, await guardChecksAt(octokit, { ...data, sha }));
      }
      continue;
    }
    reached.push(...settled);
    break;
  }

  // After the repository lock (step 5, D1): each event that reached `culprit_found`, and each
  // one still waiting for its comment, goes to `guard.revert`, one job per event.
  const pending = new Set(reached);
  for (const e of await eventsAwaitingComment(ctx.db, data.repositoryId)) pending.add(e.id);
  for (const eventId of pending) {
    await scheduleRevert(ctx, {
      installationId: data.installationId,
      repositoryId: data.repositoryId,
      owner: data.owner,
      repo: data.repo,
      eventId,
    });
  }
  return "observed";
}

export const guardObserveJob = defineJob<ObserveData>({
  name: OBSERVE_JOB,
  schema: observeSchema,
  options: { retryLimit: 3 },
  async handle(data, ctx) {
    const outcome = await observeCommit(data, ctx);
    ctx.log.info({ repositoryId: data.repositoryId, outcome }, "guard observe done");
  },
});

/**
 * `guard.confirm`: at the deadline, observe the failing commit again and settle what is due. An
 * event still undecided is examined again a window later, at most `CONFIRM_RETRIES` times, each
 * attempt with its own key; the last attempt settles it (step 4 review 1, finding 4).
 */
export async function confirmEvent(data: ConfirmData, ctx: JobContext): Promise<ObserveOutcome> {
  if (!ctx.config.guardDetection) return "disabled";
  const event = await getEvent(ctx.db, data.eventId);
  if (event?.status !== "confirming") return "observed";
  const repo = await ctx.db
    .selectFrom("repositories")
    .select(["installation_id", "full_name"])
    .where("id", "=", event.repository_id)
    .executeTakeFirst();
  if (!repo) return "inactive";
  const [owner = "", name = ""] = repo.full_name.split("/");
  const attempt = data.attempt ?? 0;
  const final = attempt >= CONFIRM_RETRIES;
  const outcome = await observeCommit(
    {
      installationId: repo.installation_id,
      repositoryId: event.repository_id,
      owner,
      repo: name,
      sha: event.failing_sha,
    },
    ctx,
    final ? { finalEventId: event.id } : {},
  );
  const still = (await getEvent(ctx.db, event.id))?.status === "confirming";
  if (!final && outcome === "observed" && still) {
    await ctx.queue.send(
      guardConfirmJob,
      { eventId: event.id, attempt: attempt + 1 },
      {
        singletonKey: confirmKey(event.id, attempt + 1),
        startAfterSeconds: ctx.config.guardConfirmSeconds,
      },
    );
    ctx.log.info({ eventId: event.id, attempt: attempt + 1 }, "guard confirm re-sent");
  }
  return outcome;
}

export const guardConfirmJob = defineJob<ConfirmData>({
  name: CONFIRM_JOB,
  schema: confirmSchema,
  options: { retryLimit: 3 },
  async handle(data, ctx) {
    await confirmEvent(data, ctx);
  },
});
