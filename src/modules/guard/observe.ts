/**
 * `guard.observe` and `guard.confirm` (Phase 1 step 4, §6, §7). The job reads CI results for one
 * default-branch commit from the API (never from the payload that triggered it), stores one class
 * per check, and runs detection and confirmation under the per-repository advisory lock. No GitHub
 * call is made inside that lock. A `culprit_found` event gets its comment afterwards, under the
 * change lock (lock order: repository lock, released, then change lock; never both).
 */
import type { Transaction } from "kysely";
import type { JobContext } from "../../core/context.js";
import type { Database, GuardCandidate, GuardFailingCheck } from "../../db/schema.js";
import type { GitHubClient } from "../../github/client-factory.js";
import { classifyGitHubError, toJobError } from "../../github/errors.js";
import {
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
import { getRepositoryModeRow } from "../modes/index.js";
import { githubWebBase, publishGuardComment, safeHtmlUrl } from "./comment.js";
import {
  type ConfirmData,
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
  const byKey = new Map<string, ObservedResult>();
  for (let page = 1; page <= RUN_PAGES; page++) {
    let data: Awaited<ReturnType<GitHubClient["rest"]["checks"]["listForRef"]>>["data"];
    try {
      data = (
        await octokit.rest.checks.listForRef({
          owner: o.owner,
          repo: o.repo,
          ref: o.sha,
          filter: "latest",
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
      // D4: two runs with one key, the latest `completed_at` wins.
      const prev = byKey.get(key);
      if (
        !prev ||
        (completedAt !== null &&
          (prev.completedAt === null || completedAt.getTime() > prev.completedAt.getTime()))
      ) {
        byKey.set(key, result);
      }
    }
    if (data.check_runs.length < 100 || page * 100 >= data.total_count) break;
  }
  return [...byKey.values()];
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
        htmlUrl: safeHtmlUrl(s.target_url, webBase),
        // A pending status is not a result yet; it never replaces one.
        completedAt: s.state === "pending" ? null : at,
      });
    }
    if (data.statuses.length < 100) break;
  }
  return [...byKey.values()];
}

/** D17: `guard.checks` of `graft.yaml` at the commit; null means every key. */
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
        singletonKey: `guard:confirm:${event.id}`,
        startAfterSeconds: d.ctx.config.guardConfirmSeconds,
      },
    );
  }
  return event.id;
}

/** D9 for every open event of the repository. Returns the events that became `culprit_found`. */
async function confirmOpenEvents(d: DetectContext): Promise<string[]> {
  const { tx, repositoryId, now } = d;
  const reached: string[] = [];
  for (const e of await openEvents(tx, repositoryId)) {
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
    if (step.step === "wait") continue;
    const status = step.step === "flaky" ? "flaky" : classifyStored(e.candidates).status;
    await updateEvent(tx, e.id, { status, confirmedAt: now, confirmReason: step.reason }, now);
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

export async function observeCommit(
  data: ObserveData,
  ctx: JobContext,
  o: { octokit?: GitHubClient } = {},
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
  if (hasStatusesRead(modeRow?.permissions)) {
    observed.push(...(await readStatuses(octokit, data, webBase)));
  }
  const allowed = await guardChecksAt(octokit, data);
  if (allowed !== null) {
    for (const r of observed) {
      if (!allowed.has(r.name)) {
        r.class = "ignored";
        r.filtered = true;
      }
    }
  }
  for (const r of observed) {
    ctx.log.debug({ key: r.key, class: r.class }, "guard result");
  }

  const now = ctx.clock.now();
  const reached = await withRepositoryGuardLock(ctx.db, data.repositoryId, async (tx) => {
    const changed = await upsertResults(tx, data.repositoryId, data.sha, observed, now);
    const d: DetectContext = {
      tx,
      ctx,
      repositoryId: data.repositoryId,
      branch: branch ?? "unknown",
      now,
    };
    const red = observed.filter((r) => changed.includes(r.key) && r.class === "red");
    if (red.length > 0) {
      const chain = (await lineTo(tx, data.repositoryId, data.sha)).map(toChainCommit);
      const results = (
        await resultsAt(
          tx,
          data.repositoryId,
          chain.map((c) => c.sha),
          red.map((r) => r.key),
        )
      ).map((r) => ({ key: r.key, sha: r.sha, class: r.class, filtered: r.filtered }));
      for (const r of red) {
        const t = detectTransition(chain, results, r.key, data.sha);
        if (t.kind === "none") {
          ctx.log.debug({ why: t.why }, "no guard transition");
          continue;
        }
        await recordTransition(d, t, { key: r.key, name: r.name, source: r.source }, r.htmlUrl);
      }
    }
    return confirmOpenEvents(d);
  });

  // After the repository lock: comments, each under its change lock (D11).
  const pending = new Set(reached);
  for (const e of await eventsAwaitingComment(ctx.db, data.repositoryId)) pending.add(e.id);
  for (const id of pending) await publishGuardComment(id, ctx, { octokit });
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

/** `guard.confirm`: at the deadline, observe the failing commit again and settle what is due. */
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
  return observeCommit(
    {
      installationId: repo.installation_id,
      repositoryId: event.repository_id,
      owner,
      repo: name,
      sha: event.failing_sha,
    },
    ctx,
  );
}

export const guardConfirmJob = defineJob<ConfirmData>({
  name: CONFIRM_JOB,
  schema: confirmSchema,
  options: { retryLimit: 3 },
  async handle(data, ctx) {
    await confirmEvent(data, ctx);
  },
});
