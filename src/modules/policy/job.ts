/**
 * `policy.evaluate` and `policy.fanout` (spec T11). Modelled on the intent and provenance jobs:
 * the PR is re-fetched, facts are computed outside the lock, then the lock is taken, freshness is
 * re-checked and the result is published. The check run ALWAYS concludes `neutral` in Phase 0.
 */
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import { GlobBudget } from "../../core/glob.js";
import { withChangeLock } from "../../db/locks.js";
import type { GitHubClient } from "../../github/client-factory.js";
import { toJobError } from "../../github/errors.js";
import { upsertManagedSection } from "../../github/managed-comment.js";
import { countApprovals, evaluatePolicy } from "../../policy/evaluate.js";
import { type LoadedPolicy, loadBasePolicy, resolveBaseCommit } from "../../policy/load.js";
import { canonicalHash } from "../../policy/parse.js";
import { PermanentJobError } from "../../queue/errors.js";
import { defineJob } from "../../queue/job.js";
import { getChange, type LivePull, upsertChangeFromPull } from "../changes/index.js";
import {
  ensureRepository,
  getActiveInstallation,
  getActiveRepository,
} from "../installations/index.js";
import { latestPublishedCard } from "../intent/index.js";
import { getChangeProvenance } from "../provenance/index.js";
import { buildFacts, listChangedPaths, listReviews } from "./facts.js";
import {
  POLICY_CHECK_NAME,
  type PolicyView,
  policyTitle,
  renderPolicyDetails,
  renderPolicySection,
  viewOutcome,
} from "./render.js";
import {
  checkRunIdForHead,
  findVerdict,
  maxFactsReadAt,
  upsertVerdict,
  type VerdictValues,
} from "./store.js";

export const POLICY_EVALUATE_JOB = "policy.evaluate";
export const POLICY_FANOUT_JOB = "policy.fanout";
export const POLICY_TRIGGERS = [
  "pr",
  "review",
  "rerequested",
  "intent",
  "provenance",
  "base_push",
] as const;
export const FANOUT_MAX = 100;
const FANOUT_BATCH = 10;
const FANOUT_STEP_SECONDS = 5;

const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/;

/** IDs and names only: never text, file content or YAML. */
export const evaluateSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: z.string().regex(NAME_PART),
  repo: z.string().regex(NAME_PART),
  prNumber: z.number().int().positive(),
  trigger: z.enum(POLICY_TRIGGERS),
  deliveryId: z.string().max(100).optional(),
});
export type EvaluateData = z.infer<typeof evaluateSchema>;

export const fanoutSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: z.string().regex(NAME_PART),
  repo: z.string().regex(NAME_PART),
  branch: z.string().min(1).max(255),
  afterSha: z.string().regex(/^[0-9a-f]{40}$/),
  deliveryId: z.string().max(100),
});
export type FanoutData = z.infer<typeof fanoutSchema>;

export type PolicyOutcomeResult = "published" | "unchanged" | "stale" | "closed" | "skipped";

export async function evaluatePolicyJobRun(
  data: EvaluateData,
  ctx: JobContext,
): Promise<PolicyOutcomeResult> {
  const { config } = ctx;
  const done = (outcome: PolicyOutcomeResult, extra: Record<string, unknown> = {}) => {
    ctx.log.info(
      { outcome, prNumber: data.prNumber, trigger: data.trigger, ...extra },
      "policy evaluate done",
    );
    return outcome;
  };

  // 1. Load.
  const installation = await getActiveInstallation(ctx.db, data.installationId);
  if (!installation) return done("skipped", { reason: "installation inactive" });
  let octokit: GitHubClient;
  try {
    octokit = await ctx.github.forInstallation(data.installationId);
  } catch (err) {
    throw toJobError(err, "installation token");
  }
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
  if (pull.number !== data.prNumber || pull.base.repo.id !== data.repositoryId) {
    throw new PermanentJobError(
      "pull request does not belong to the expected repository",
      "repo_mismatch",
    );
  }
  const now = ctx.clock.now();
  if ((await ensureRepository(ctx.db, data.installationId, pull.base.repo, now)) === "removed") {
    return done("skipped", { reason: "repository removed" });
  }
  const { change, applied } = await upsertChangeFromPull(ctx.db, data.repositoryId, pull, now);
  if (!applied) return done("stale", { changeId: change.id, reason: "newer snapshot stored" });
  if (pull.state === "closed") return done("closed", { changeId: change.id });

  // 2. Everything read from here on is "as of" this instant (D16).
  const factsReadAt = ctx.clock.now();
  const headSha = pull.head.sha;
  const baseRef = pull.base.ref;

  // 3. The policy: the base branch's tip, never the PR head (D3).
  let loaded: LoadedPolicy;
  try {
    const commitSha = await resolveBaseCommit(octokit, {
      owner: data.owner,
      repo: data.repo,
      baseRef,
    });
    loaded = await loadBasePolicy(octokit, {
      repositoryId: data.repositoryId,
      owner: data.owner,
      repo: data.repo,
      commitSha,
      log: ctx.log,
    });
  } catch (err) {
    throw toJobError(err, "read graft.yaml");
  }

  // 4. Facts and verdict.
  const view: PolicyView = {
    state: loaded.status,
    owner: data.owner,
    baseRef,
    commitSha: loaded.commitSha,
    headSha,
    fileSha: loaded.fileSha,
    hash: loaded.status === "ok" ? loaded.hash : null,
    policy: loaded.status === "ok" ? loaded.policy : null,
    verdict: null,
    facts: null,
    approvals: null,
    errors: loaded.status === "invalid" ? loaded.errors : [],
    warnings: loaded.status === "ok" ? loaded.warnings : [],
    addsPolicyFile: false,
  };
  try {
    if (loaded.status === "ok") {
      const listed = await listChangedPaths(octokit, {
        owner: data.owner,
        repo: data.repo,
        prNumber: data.prNumber,
        changedFiles: pull.changed_files,
      });
      const { reviews, truncated } = await listReviews(octokit, {
        owner: data.owner,
        repo: data.repo,
        prNumber: data.prNumber,
      });
      const card = await latestPublishedCard(ctx.db, change.id);
      const provenance = await getChangeProvenance(ctx.db, change.id);
      // After the database reads, so that the wall-clock guard does not include them.
      const globBudget = new GlobBudget();
      const facts = buildFacts({
        budget: globBudget,
        pull,
        files: listed.files,
        complete: listed.complete,
        card,
        provenance,
        configSensitivePaths: config.intentSensitivePaths,
        policySensitivePaths: loaded.policy.sensitivePaths,
      });
      view.facts = facts;
      view.verdict = evaluatePolicy(loaded.policy, facts, { budget: globBudget });
      view.approvals = countApprovals(reviews, {
        headSha,
        prAuthorLogin: pull.user?.login ?? "ghost",
        truncated,
      });
    } else if (loaded.status === "missing") {
      const listed = await listChangedPaths(octokit, {
        owner: data.owner,
        repo: data.repo,
        prNumber: data.prNumber,
        changedFiles: pull.changed_files,
      });
      view.addsPolicyFile = listed.files.some(
        (f) => f.path === "graft.yaml" && f.status === "added",
      );
    }
  } catch (err) {
    throw toJobError(err, "read pull request facts");
  }

  // 5. Render, then fingerprint what is shown.
  const outcome = viewOutcome(view);
  const title = policyTitle(view);
  const summary = renderPolicySection(view);
  const details = renderPolicyDetails(view);
  const factsHash = canonicalHash({
    verdict: view.verdict,
    approvals: view.approvals,
    policyStatus: view.state,
    policyFileSha: view.fileSha,
    policyHash: view.hash,
    errors: view.errors,
    headSha,
    baseRef,
    commitSha: view.commitSha,
    // What reviewers read depends on more than the verdict (author name, labels, size ...).
    rendered: { title, summary, details },
  });

  const identity = { changeId: change.id, headSha, policyFileSha: view.fileSha };
  const fresh = (current: Awaited<ReturnType<typeof getChange>>): boolean =>
    !!current &&
    current.head_sha === headSha &&
    !(current.pr_updated_at !== null && current.pr_updated_at > new Date(pull.updated_at));

  // 6. Lock, re-check, publish.
  const result = await withChangeLock(ctx.db, change.id, async (tx) => {
    const current = await getChange(tx, change.id);
    if (!current || !fresh(current)) {
      ctx.log.info({ changeId: change.id }, "stale: head moved or newer snapshot stored");
      return "stale" as const;
    }
    const latest = await maxFactsReadAt(tx, change.id);
    if (latest !== null && latest > factsReadAt) {
      ctx.log.info({ changeId: change.id }, "stale: a later evaluation already published");
      return "stale" as const;
    }
    const existing = await findVerdict(tx, identity);
    const stamp = ctx.clock.now();
    const values = (checkRunId: number | null, publishedAt: Date | null): VerdictValues => ({
      ...identity,
      baseRef,
      policyCommitSha: view.commitSha,
      policyStatus: view.state,
      policyHash: view.hash,
      outcome,
      riskClass: view.verdict?.effectiveRisk.value ?? null,
      riskFinal: view.verdict?.effectiveRisk.final ?? false,
      riskSource: view.verdict?.effectiveRisk.source ?? null,
      authorKind: view.facts?.author.kind ?? null,
      policyFileChanged: view.verdict?.policyFileChanged ?? view.addsPolicyFile,
      rulesMatched: storedRules(view),
      required: storedRequired(view),
      approvals: view.approvals ? { ...view.approvals } : {},
      errors: view.errors.map(({ key: _key, ...rest }) => rest),
      factsHash,
      factsReadAt,
      checkRunId,
      publishedAt,
      evaluatedAt: stamp,
    });
    if (
      existing &&
      existing.facts_hash === factsHash &&
      existing.check_run_id !== null &&
      existing.published_at !== null
    ) {
      // Nothing to say that GitHub does not already show: no request, but the row keeps the
      // latest read time so an older job cannot overtake it.
      await upsertVerdict(tx, values(existing.check_run_id, existing.published_at));
      return "unchanged" as const;
    }
    try {
      const body = {
        name: POLICY_CHECK_NAME,
        status: "completed" as const,
        // Phase 0 (spec fix 1): the check decides nothing. Never derive this from the outcome.
        conclusion: "neutral" as const,
        external_id: change.id,
        completed_at: stamp.toISOString(),
        output: { title, summary, ...(details !== null ? { text: details } : {}) },
      };
      let checkRunId = await checkRunIdForHead(tx, change.id, headSha);
      if (checkRunId === null) {
        const listed = await octokit.rest.checks.listForRef({
          owner: data.owner,
          repo: data.repo,
          ref: headSha,
          check_name: POLICY_CHECK_NAME,
          app_id: config.githubAppId,
          filter: "latest",
        });
        checkRunId = listed.data.check_runs[0]?.id ?? null;
      }
      if (checkRunId !== null) {
        await octokit.rest.checks.update({
          owner: data.owner,
          repo: data.repo,
          check_run_id: checkRunId,
          ...body,
        });
      } else {
        const created = await octokit.rest.checks.create({
          owner: data.owner,
          repo: data.repo,
          head_sha: headSha,
          ...body,
        });
        checkRunId = created.data.id;
      }
      const comment = await upsertManagedSection(octokit, {
        owner: data.owner,
        repo: data.repo,
        issueNumber: data.prNumber,
        appId: config.githubAppId,
        appBotLogin: config.githubAppSlug ? `${config.githubAppSlug}[bot]` : undefined,
        knownCommentId: current.graft_comment_id,
        section: "policy",
        markdown: summary,
      });
      await tx
        .updateTable("changes")
        .set({ graft_comment_id: comment.commentId })
        .where("id", "=", change.id)
        .execute();
      await upsertVerdict(tx, values(checkRunId, ctx.clock.now()));
    } catch (err) {
      // Rolls the transaction back; the retry repeats everything without creating duplicates.
      throw toJobError(err, "publish");
    }
    return "published" as const;
  });

  return done(result, {
    changeId: change.id,
    policyStatus: view.state,
    verdict: outcome,
    matched: view.verdict?.matched.length ?? 0,
    uncertain: view.verdict?.matched.some((m) => m.reasons.some((r) => r.uncertain)) ?? false,
  });
}

/** Rule indices, actions, reason keys and PR paths (at most 5): no globs, names or team slugs. */
function storedRules(view: PolicyView): unknown[] {
  return (view.verdict?.matched ?? []).map((m) => ({
    index: m.index,
    action: m.action,
    overridden: m.overridden,
    reasons: m.reasons.map((r) => ({
      key: r.key,
      uncertain: r.uncertain,
      // Labels are PR text that also appears in the policy; keep only the count.
      paths: r.key === "paths" ? r.paths : [],
      count: r.count,
    })),
  }));
}

function storedRequired(view: PolicyView): Record<string, unknown> {
  const v = view.verdict;
  if (v?.outcome === "would_require") {
    return {
      humans: v.humans,
      constraints: v.constraints.map((c) => ({
        humans: c.humans,
        teamCount: c.teams.length,
        rules: c.rules,
      })),
      usedDefault: v.usedDefault,
      builtIn: v.builtIn,
    };
  }
  if (v?.outcome === "would_block") return { blockedBy: v.blockedBy };
  return {};
}

export const policyEvaluateJob = defineJob<EvaluateData>({
  name: POLICY_EVALUATE_JOB,
  schema: evaluateSchema,
  options: { retryLimit: 5, retryDelaySeconds: 30, retryBackoff: true, expireInSeconds: 120 },
  async handle(data, ctx) {
    await evaluatePolicyJobRun(data, ctx);
  },
});

// ---------------------------------------------------------------------------------------------
// Fan-out (D18)
// ---------------------------------------------------------------------------------------------

export async function fanoutPolicy(data: FanoutData, ctx: JobContext): Promise<number> {
  if (!(await getActiveInstallation(ctx.db, data.installationId))) {
    ctx.log.info({ outcome: "skipped", reason: "installation inactive" }, "policy fanout done");
    return 0;
  }
  if (!(await getActiveRepository(ctx.db, data.repositoryId))) {
    ctx.log.info({ outcome: "skipped", reason: "repository removed" }, "policy fanout done");
    return 0;
  }
  const rows = await ctx.db
    .selectFrom("changes")
    .select(["pr_number"])
    .where("repository_id", "=", data.repositoryId)
    .where("state", "=", "open")
    .where("base_ref", "=", data.branch)
    .orderBy("pr_updated_at", (ob) => ob.desc().nullsLast())
    .orderBy("pr_number", "desc")
    .limit(FANOUT_MAX + 1)
    .execute();
  if (rows.length > FANOUT_MAX) {
    ctx.log.warn({ outcome: "fanout_truncated", max: FANOUT_MAX }, "policy fanout truncated");
  }
  const chosen = rows.slice(0, FANOUT_MAX);
  for (const [i, row] of chosen.entries()) {
    await ctx.queue.send(
      policyEvaluateJob,
      {
        installationId: data.installationId,
        repositoryId: data.repositoryId,
        owner: data.owner,
        repo: data.repo,
        prNumber: row.pr_number,
        trigger: "base_push",
        deliveryId: data.deliveryId,
      },
      {
        singletonKey: `policy:base:${data.repositoryId}:${row.pr_number}:${data.afterSha}`,
        startAfterSeconds: Math.floor(i / FANOUT_BATCH) * FANOUT_STEP_SECONDS,
      },
    );
  }
  ctx.log.info({ outcome: "enqueued", count: chosen.length }, "policy fanout done");
  return chosen.length;
}

export const policyFanoutJob = defineJob<FanoutData>({
  name: POLICY_FANOUT_JOB,
  schema: fanoutSchema,
  options: { retryLimit: 5, retryDelaySeconds: 30, retryBackoff: true, expireInSeconds: 120 },
  async handle(data, ctx) {
    await fanoutPolicy(data, ctx);
  },
});
