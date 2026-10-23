/**
 * `policy.evaluate` and `policy.fanout` (spec T11). Modelled on the intent and provenance jobs:
 * the PR is re-fetched, facts are computed outside the lock, then the lock is taken, freshness is
 * re-checked and the result is published.
 *
 * Phase 1 step 2: the enforce conclusion is computed in every mode (`src/policy/enforce.ts`) and
 * stored; it is PUBLISHED only when the effective `policy_mode` is `enforce`. In report mode the
 * check concludes `neutral`, whatever the verdict says. This job never names a non-neutral
 * conclusion itself: it passes through what `publishedCheck` returns.
 */
import type { Transaction } from "kysely";
import { z } from "zod";
import { canRetry, type JobContext } from "../../core/context.js";
import { GlobBudget } from "../../core/glob.js";
import { withChangeLock } from "../../db/locks.js";
import type { Database } from "../../db/schema.js";
import type { GitHubClient } from "../../github/client-factory.js";
import { toJobError } from "../../github/errors.js";
import { upsertManagedSection } from "../../github/managed-comment.js";
import { MutationRefusedError } from "../../github/mutation-guard.js";
import {
  type ApproverFacts,
  type Enforced,
  enforcedConclusion,
  type PublishedCheck,
  publishedCheck,
} from "../../policy/enforce.js";
import { type ApprovalCount, countApprovals, evaluateWithReport } from "../../policy/evaluate.js";
import { type LoadedPolicy, loadBasePolicy, resolveBaseCommit } from "../../policy/load.js";
import { canonicalHash } from "../../policy/parse.js";
import { PermanentJobError } from "../../queue/errors.js";
import { defineJob } from "../../queue/job.js";
import { insertAuditRow, type NewAuditRow } from "../audit/index.js";
import { type Change, getChange, type LivePull, upsertChangeFromPull } from "../changes/index.js";
import {
  ensureRepository,
  getActiveInstallation,
  getActiveRepository,
} from "../installations/index.js";
import { latestPublishedCard } from "../intent/index.js";
import { getEffectiveModes } from "../modes/effective.js";
import { getChangeProvenance } from "../provenance/index.js";
import { resolveApprovers } from "./approvals.js";
import { type BreakGlassFacts, type BreakGlassState, resolveBreakGlass } from "./break-glass.js";
import { buildFacts, listChangedPaths, listCommitLogins, listReviews } from "./facts.js";
import {
  type BreakGlassView,
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
  headFirstEvaluatedAt,
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
  "mode",
  // Phase 1 step 2: a team or membership change (D14), the end of the card wait (D9).
  "team",
  "card_wait",
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
  /**
   * Step 3 (D4): the head SHA of the `labeled` delivery, set only when the label is the
   * break-glass label. A filter: the job applies a break-glass only when the live head equals it.
   */
  breakGlassHeadSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  /**
   * Step 3 review 1 (finding 1): the user id of the `labeled` delivery, set with
   * `breakGlassHeadSha`. A filter only: the newest label event (API data) must be a `labeled` one
   * by this user, or nothing is applied. The actor, login and role still come from the API.
   */
  breakGlassActorId: z.number().int().positive().optional(),
  /**
   * Step 3 review 1 (finding 2): set for an `unlabeled` delivery of the break-glass label. A
   * refusal only: it ends an active break-glass of the change, whatever `pulls.get` shows now.
   */
  breakGlassUnlabeled: z.literal(true).optional(),
});
export type EvaluateData = z.infer<typeof evaluateSchema>;

const fanoutBase = {
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: z.string().regex(NAME_PART),
  repo: z.string().regex(NAME_PART),
};

/**
 * `branch`: the open PRs of one base branch after a push (the Phase 0 path). `repository`: every
 * open PR of the repository after a mode change (a `mode_changes` row) or a ceiling change.
 */
export const fanoutSchema = z.preprocess(
  // Jobs queued before Phase 1 have no `scope`; they are branch fan-outs.
  (v) => (typeof v === "object" && v !== null && !("scope" in v) ? { ...v, scope: "branch" } : v),
  z.discriminatedUnion("scope", [
    z.object({
      scope: z.literal("branch"),
      ...fanoutBase,
      branch: z.string().min(1).max(255),
      afterSha: z.string().regex(/^[0-9a-f]{40}$/),
      deliveryId: z.string().max(100),
    }),
    z.object({
      scope: z.literal("repository"),
      ...fanoutBase,
      reason: z.enum(["mode_change", "ceiling_change"]),
      changeId: z.uuid().nullable(),
      /** Epoch ms of the ceiling change, so that a later change back to a value is not deduplicated. */
      ceilingAt: z.number().int().nonnegative().nullable(),
    }),
  ]),
);
export type FanoutData = z.infer<typeof fanoutSchema>;
export type RepositoryFanoutData = Extract<FanoutData, { scope: "repository" }>;

export type PolicyOutcomeResult = "published" | "unchanged" | "stale" | "closed" | "skipped";

/** How many times one run may re-read the PR to catch up with a newer snapshot of its head. */
export const MAX_CATCH_UPS = 3;

/**
 * What the verdict and its rendering read from the pull that can change without a new head: the
 * base branch, the labels, the size, the author and the state. Compared in memory between two
 * snapshots of the same PR; never stored or logged.
 */
function verdictInputsKey(p: LivePull): string {
  return JSON.stringify([
    p.head.sha,
    p.base.ref,
    p.state,
    (p.labels ?? []).map((l) => l.name),
    p.additions,
    p.deletions,
    p.changed_files,
    p.user?.login ?? null,
    p.user?.type ?? null,
  ]);
}

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
    // The `policy` feature (D11): the only client that may publish a non-neutral graft/policy.
    octokit = await ctx.github.forInstallation(data.installationId, { feature: "policy" });
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
  const repoState = await ensureRepository(ctx.db, data.installationId, pull.base.repo, now);
  if (repoState === "removed") return done("skipped", { reason: "repository removed" });
  // Read once, outside the lock (step 2 D12). It decides the wording, the facts hash and whether
  // the enforce conclusion is published; a rollback that lands in between is refused by the gate.
  // A transfer race (review 1, finding 6): the row still belongs to the previous installation,
  // whose modes this job must not act on. It evaluates under a `report` ceiling instead, which is
  // what the D13 reset gives the new owner; `installation_repositories.added` then moves the row.
  const moved = repoState === "other_installation";
  if (moved)
    ctx.log.info({ prNumber: data.prNumber }, "policy: repository on another installation");
  const modes = await getEffectiveModes(
    ctx.db,
    data.repositoryId,
    moved ? { modeCeiling: "report" } : config,
  );
  const { change, applied } = await upsertChangeFromPull(ctx.db, data.repositoryId, pull, now);

  /**
   * Another job stored a newer snapshot of the SAME head. Usually that is Graft's own comment or
   * check run bumping the PR's `updated_at`, not a change to what the verdict is made of. Re-read
   * the PR: if `verdictInputsKey` is unchanged, adopt the newer snapshot and carry on; otherwise the
   * change is real, and the job its webhook queued publishes instead. Bounded by MAX_CATCH_UPS per
   * run. Never called inside a lock (it reads GitHub). The D16 order is untouched: `factsReadAt`
   * stays the time the facts were read, and a later evaluation still wins.
   */
  let catchUps = 0;
  const catchUp = async (): Promise<boolean> => {
    while (catchUps < MAX_CATCH_UPS) {
      catchUps++;
      let live: LivePull;
      try {
        const res = await octokit.rest.pulls.get({
          owner: data.owner,
          repo: data.repo,
          pull_number: data.prNumber,
        });
        live = res.data as unknown as LivePull;
      } catch (err) {
        throw toJobError(err, "pulls.get");
      }
      if (verdictInputsKey(live) !== verdictInputsKey(pull)) return false;
      const stored = await upsertChangeFromPull(ctx.db, data.repositoryId, live, ctx.clock.now());
      pull = live;
      if (stored.applied) {
        ctx.log.info({ changeId: change.id, catchUps }, "caught up with a newer snapshot");
        return true;
      }
      if (stored.change.head_sha !== live.head.sha) return false;
    }
    return false;
  };

  /**
   * Review 1, finding 4: a run queued by the break-glass label that ends `stale` before it wrote
   * its audit row would drop the request silently (the next run is not the label's trigger). Send
   * it again with its filters, once per delivery; they only refuse, so a re-run grants nothing new.
   */
  const resendLabelRun = async (headSha: string): Promise<void> => {
    if (data.breakGlassHeadSha === undefined || config.breakGlassLabel === null) return;
    const stored = await getChange(ctx.db, change.id);
    if (stored?.head_sha !== headSha) return;
    await ctx.queue.send(policyEvaluateJob, data, {
      singletonKey: `policy:breakglass:${change.id}:${headSha}:${data.deliveryId ?? "none"}`,
    });
  };

  if (!applied && !(change.head_sha === pull.head.sha && (await catchUp()))) {
    await resendLabelRun(pull.head.sha);
    return done("stale", { changeId: change.id, reason: "newer snapshot stored" });
  }
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
    mode: { effective: modes.policy.effective },
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
      // Phase 1 step 6 (D13): when an MCP report disagreed, the stricter of the verdicts with
      // the unknown author and with the trailers' author.
      const disagreed =
        provenance !== undefined &&
        provenance.head_sha === headSha &&
        provenance.mcp_report === "disagrees";
      view.verdict = evaluateWithReport(
        loaded.policy,
        facts,
        disagreed ? { kind: provenance.author_kind, agent: provenance.agent } : null,
        { budget: globBudget },
      );
      // Phase 1 step 6 (D19): a PR opened through MCP is authored by Graft's bot, so the people
      // whose commits it holds are excluded like a PR author; unknown authors exclude everyone.
      let excludedLogins: readonly string[] | "everyone" | undefined;
      if (await openedThroughMcp(ctx.db, data.repositoryId, data.prNumber)) {
        excludedLogins =
          (await listCommitLogins(octokit, {
            owner: data.owner,
            repo: data.repo,
            prNumber: data.prNumber,
            commits: pull.commits,
          })) ?? "everyone";
      }
      view.approvals = countApprovals(reviews, {
        headSha,
        prAuthorLogin: pull.user?.login ?? "ghost",
        truncated,
        ...(excludedLogins === undefined ? {} : { excludedLogins }),
      });
      // Who counts (step 2, §5): role checks and team memberships, in every mode, before the lock.
      view.approvers = await resolveApprovers(octokit, {
        owner: data.owner,
        repo: data.repo,
        approvals: view.approvals,
        verdict: view.verdict,
        accountType: installation.account_type,
        permissions: installation.permissions_read_at === null ? null : installation.permissions,
        associations: new Map(
          reviews.flatMap((r) =>
            r.user && r.author_association !== undefined
              ? [[r.user.id, r.author_association] as const]
              : [],
          ),
        ),
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

  // 4b. Break-glass (step 3, §6): only when the feature is on. Outside the lock; it writes nothing.
  let breakGlass: BreakGlassFacts = { state: "none", revoke: null };
  if (config.breakGlassLabel !== null) {
    try {
      breakGlass = await resolveBreakGlass(octokit, ctx.db, {
        owner: data.owner,
        repo: data.repo,
        prNumber: data.prNumber,
        changeId: change.id,
        headSha,
        label: config.breakGlassLabel,
        labels: (pull.labels ?? []).map((l) => l.name),
        authorId: pull.user?.id ?? null,
        breakGlassHeadSha: data.breakGlassHeadSha,
        breakGlassActorId: data.breakGlassActorId,
        breakGlassUnlabeled: data.breakGlassUnlabeled,
        canRetry: canRetry(ctx),
      });
    } catch (err) {
      throw toJobError(err, "break-glass");
    }
  }
  view.breakGlass = breakGlassView(breakGlass);

  // 5. The enforce conclusion (step 2, §7), computed in every mode; published only in enforce.
  const waitMs = config.policyCardWaitSeconds * 1000;
  let cardWaitUntil: Date | null = null;
  if (waitMs > 0 && view.verdict?.effectiveRisk.source === "card_pending") {
    const first = (await headFirstEvaluatedAt(ctx.db, change.id, headSha)) ?? factsReadAt;
    const deadline = new Date(first.getTime() + waitMs);
    if (factsReadAt < deadline) cardWaitUntil = deadline;
  }
  const enforced = enforcedConclusion({
    state: view.state,
    verdict: view.verdict,
    approvers: view.approvers ?? null,
    cardWait: cardWaitUntil !== null,
    // D5: only a break-glass verified for THIS head; it wins over every other rule.
    breakGlass: breakGlass.state === "applied" ? { applied: true } : null,
  });
  view.enforced = enforced;
  const published = publishedCheck(modes.policy.effective, enforced);

  // 6. Render, then fingerprint what is shown.
  const outcome = viewOutcome(view);
  const title = policyTitle(view);
  const summary = renderPolicySection(view);
  const details = renderPolicyDetails(view);
  const factsHash = policyFactsHash({
    verdict: view.verdict,
    approvals: view.approvals,
    policyStatus: view.state,
    policyFileSha: view.fileSha,
    policyHash: view.hash,
    errors: view.errors,
    headSha,
    baseRef,
    commitSha: view.commitSha,
    policyMode: modes.policy.effective,
    enforced,
    published,
    breakGlass: breakGlassHashTerm(breakGlass, headSha),
    rendered: { title, summary, details },
  });

  /**
   * The audit rows this evaluation calls for (§6 step 4, D7, D9), in the caller's transaction: the
   * `removed` row of a bypass it ended (review 1), then the state's own row. The store applies the
   * dedup rules; replayed states (`record: false`) write nothing. A row written after a `removed`
   * one is stamped 1 ms later, so that the removal (which ends every earlier or simultaneous
   * `applied` row of the change) never ends the bypass verified in the same run.
   */
  const recordAudit = async (tx: Transaction<Database>): Promise<boolean> => {
    const common = {
      repositoryId: data.repositoryId,
      changeId: change.id,
      prNumber: data.prNumber,
      policyMode: modes.policy.effective,
    };
    const at = ctx.clock.now();
    let wrote = false;
    const revoke = breakGlass.revoke;
    if (revoke !== null) {
      wrote = await insertAuditRow(tx, {
        ...common,
        headSha: revoke.headSha,
        kind: "removed",
        reason: null,
        actor: revoke.actor,
        role: null,
        self: false,
        labelEventAt: revoke.labelEventAt,
        createdAt: at,
      });
    }
    const row = auditRowFor(breakGlass);
    if (row === null) return wrote;
    const own = await insertAuditRow(tx, {
      ...common,
      ...row,
      headSha,
      createdAt: revoke === null ? at : new Date(at.getTime() + 1),
    });
    return own || wrote;
  };
  // A newly verified break-glass whose run lost the race to a later evaluation (below).
  let auditWrittenWhileStale = false;

  const identity = { changeId: change.id, headSha, policyFileSha: view.fileSha };
  const fresh = (current: Change | undefined): boolean =>
    !!current &&
    current.head_sha === headSha &&
    !(current.pr_updated_at !== null && current.pr_updated_at > new Date(pull.updated_at));
  /**
   * Run `fn` under the change lock while the stored snapshot is this run's. When it is behind on
   * the same head, release the lock, catch up and try again; `null` when the run is out of date.
   */
  const underFreshLock = async <T>(
    fn: (tx: Transaction<Database>, current: Change) => Promise<T>,
  ): Promise<T | null> => {
    for (;;) {
      const r: { ok: true; value: T } | { ok: false; behind: boolean } = await withChangeLock(
        ctx.db,
        change.id,
        async (tx) => {
          const current = await getChange(tx, change.id);
          if (!current || !fresh(current)) {
            ctx.log.info({ changeId: change.id }, "stale: head moved or newer snapshot stored");
            return { ok: false, behind: !!current && current.head_sha === headSha };
          }
          return { ok: true, value: await fn(tx, current) };
        },
      );
      if (r.ok) return r.value;
      if (!r.behind || !(await catchUp())) return null;
    }
  };

  // 7. Lock, re-check, publish.
  const publish = underFreshLock(async (tx, current) => {
    const latest = await maxFactsReadAt(tx, change.id);
    if (latest !== null && latest > factsReadAt) {
      ctx.log.info({ changeId: change.id }, "stale: a later evaluation already published");
      // The later run may not have been the label's own trigger, so it did not verify the
      // break-glass. Keep what this run verified for the same head, and re-evaluate (below).
      if (await recordAudit(tx)) auditWrittenWhileStale = true;
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
      approvals: storedApprovals(view.approvals, view.approvers ?? null, enforced),
      errors: view.errors.map(({ key: _key, ...rest }) => rest),
      policyMode: modes.policy.effective,
      enforcedConclusion: enforced.conclusion,
      enforcedReason: enforced.reason,
      checkConclusion: published.stored,
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
      await recordAudit(tx);
      await upsertVerdict(tx, values(existing.check_run_id, existing.published_at));
      return "unchanged" as const;
    }
    try {
      const body = {
        name: POLICY_CHECK_NAME,
        external_id: change.id,
        output: { title, summary, text: details },
        // Report mode (spec fix 1): `completed` + `neutral`, never derived from the outcome.
        // Enforce mode: what `publishedCheck` returns; `in_progress` carries no conclusion.
        ...checkState(published, stamp),
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
      // Step 3: the audit row commits with the verdict; a rollback drops both, and the retry
      // writes them again (the D7 dedup makes that safe).
      await recordAudit(tx);
      await upsertVerdict(tx, values(checkRunId, ctx.clock.now()));
    } catch (err) {
      // D12: a rollback committed between the mode read and this write. Not an error: the
      // rollback fan-out republishes. Thrown (not returned) so the transaction rolls back.
      if (err instanceof MutationRefusedError && err.refusal === "mode_report") {
        throw new ModeChangedDuringEvaluation();
      }
      // Rolls the transaction back; the retry repeats everything without creating duplicates.
      throw toJobError(err, "publish");
    }
    return "published" as const;
  });

  let result: Exclude<PolicyOutcomeResult, "closed" | "skipped">;
  // Whether this run's audit rows were written (or found already there) in a committed transaction.
  let auditCommitted = false;
  try {
    const r = await publish;
    auditCommitted = r !== null;
    result = r ?? "stale";
  } catch (err) {
    if (!(err instanceof ModeChangedDuringEvaluation)) throw err;
    ctx.log.info(
      { changeId: change.id, prNumber: data.prNumber },
      "mode changed during evaluation",
    );
    result = "stale";
  }
  // Review 1, finding 4: out of date, or rolled back by a mode change, before the row was written.
  if (!auditCommitted) await resendLabelRun(headSha);

  // Step 3: a break-glass row written by a run that lost the race is shown by a new evaluation.
  if (auditWrittenWhileStale) {
    await ctx.queue.send(
      policyEvaluateJob,
      {
        installationId: data.installationId,
        repositoryId: data.repositoryId,
        owner: data.owner,
        repo: data.repo,
        prNumber: data.prNumber,
        trigger: "pr",
      },
      { singletonKey: `policy:breakglass:${change.id}:${headSha}:${factsReadAt.getTime()}` },
    );
  }

  // D9: re-evaluate at the end of the card wait, in every mode (the singleton key makes it once).
  if (cardWaitUntil !== null && result !== "stale") {
    const seconds = Math.max(
      1,
      Math.ceil((cardWaitUntil.getTime() - factsReadAt.getTime()) / 1000),
    );
    await ctx.queue.send(
      policyEvaluateJob,
      {
        installationId: data.installationId,
        repositoryId: data.repositoryId,
        owner: data.owner,
        repo: data.repo,
        prNumber: data.prNumber,
        trigger: "card_wait",
      },
      { singletonKey: `policy:cardwait:${change.id}:${headSha}`, startAfterSeconds: seconds },
    );
  }

  return done(result, {
    changeId: change.id,
    policyStatus: view.state,
    verdict: outcome,
    matched: view.verdict?.matched.length ?? 0,
    uncertain: view.verdict?.matched.some((m) => m.reasons.some((r) => r.uncertain)) ?? false,
  });
}

/** Phase 1 step 6 (D19): whether `open_change` opened this PR (an `mcp_changes` row). */
async function openedThroughMcp(
  db: JobContext["db"],
  repositoryId: number,
  prNumber: number,
): Promise<boolean> {
  const row = await db
    .selectFrom("mcp_changes")
    .select("id")
    .where("repository_id", "=", repositoryId)
    .where("pr_number", "=", prNumber)
    .executeTakeFirst();
  return row !== undefined;
}

/** D12: the gate refused the check write with `mode_report`; caught outside the lock. */
class ModeChangedDuringEvaluation extends Error {
  constructor() {
    super("mode changed during evaluation");
    this.name = "ModeChangedDuringEvaluation";
  }
}

/** The status fields of the check body (§9). The conclusion is passed through, never chosen here. */
function checkState(
  p: PublishedCheck,
  at: Date,
):
  | { status: "in_progress" }
  | {
      status: "completed";
      conclusion: NonNullable<PublishedCheck["conclusion"]>;
      completed_at: string;
    } {
  if (p.status === "in_progress" || p.conclusion === null) return { status: "in_progress" };
  return { status: "completed", conclusion: p.conclusion, completed_at: at.toISOString() };
}

export interface FactsHashInput {
  verdict: unknown;
  approvals: unknown;
  policyStatus: string;
  policyFileSha: string | null;
  policyHash: string | null;
  errors: unknown;
  headSha: string;
  baseRef: string;
  commitSha: string;
  /** Without this a mode change would leave the hash equal and nothing would be republished (D8). */
  policyMode: string;
  /** Step 2: what enforce mode concludes (conclusion, reason, per-constraint `met` and counts). */
  enforced: Enforced;
  /** Step 2: the status and conclusion actually sent. */
  published: PublishedCheck;
  /** Step 3 (D10): a break-glass changes the conclusion, so it must republish on its own. */
  breakGlass: BreakGlassHashTerm;
  /** What reviewers read depends on more than the verdict (author name, labels, size ...). */
  rendered: { title: string; summary: string; details: string };
}

/** The "unchanged" short cut compares this hash: everything that decides what GitHub shows. */
export function policyFactsHash(i: FactsHashInput): string {
  return canonicalHash({
    verdict: i.verdict,
    approvals: i.approvals,
    policyStatus: i.policyStatus,
    policyFileSha: i.policyFileSha,
    policyHash: i.policyHash,
    errors: i.errors,
    headSha: i.headSha,
    baseRef: i.baseRef,
    commitSha: i.commitSha,
    policyMode: i.policyMode,
    enforced: {
      conclusion: i.enforced.conclusion,
      reason: i.enforced.reason,
      constraints: i.enforced.constraints.map((c) => ({
        humans: c.humans,
        teamCount: c.teams.length,
        met: c.met,
        approved: c.approvedCount,
        unverified: c.unverified.length,
      })),
    },
    published: { status: i.published.status, conclusion: i.published.conclusion },
    breakGlass: i.breakGlass,
    rendered: i.rendered,
  });
}

/** D10: `applied` / `none` / `stale` / `ignored`, the actor id and the head SHA. */
export interface BreakGlassHashTerm {
  state: "applied" | "none" | "stale" | "ignored";
  actorId: number | null;
  headSha: string;
}

export function breakGlassHashTerm(b: BreakGlassState, headSha: string): BreakGlassHashTerm {
  switch (b.state) {
    case "applied":
    case "ignored":
      return { state: b.state, actorId: b.actor?.id ?? null, headSha };
    case "stale":
      return { state: "stale", actorId: null, headSha };
    default:
      // A bypass that ended returns the check to normal: the same term as no break-glass at all.
      return { state: "none", actorId: null, headSha };
  }
}

/** What the rendering shows (§7); `removed` and `none` show nothing. */
function breakGlassView(b: BreakGlassState): BreakGlassView | null {
  switch (b.state) {
    case "applied":
      return {
        state: "applied",
        login: b.actor.login,
        role: b.role,
        headSha: b.headSha,
        self: b.self,
        labelEventAt: b.labelEventAt,
      };
    case "ignored":
      return {
        state: "ignored",
        reason: b.reason,
        login: b.actor?.login ?? null,
        role: b.role,
        self: b.self,
        labelEventAt: b.labelEventAt,
      };
    case "stale":
      return { state: "stale" };
    default:
      return null;
  }
}

/** The audit row fields a state calls for, or null (D7). Removals come from `revoke`. */
function auditRowFor(
  b: BreakGlassState,
): Pick<
  NewAuditRow,
  "kind" | "reason" | "actor" | "role" | "self" | "labelEventAt" | "labelEventId"
> | null {
  switch (b.state) {
    case "applied":
      return b.record
        ? {
            kind: "applied",
            reason: null,
            actor: b.actor,
            role: b.role,
            self: b.self,
            labelEventAt: b.labelEventAt,
            labelEventId: b.labelEventId,
          }
        : null;
    case "ignored":
      return b.record
        ? {
            kind: "ignored",
            reason: b.reason,
            actor: b.actor,
            role: b.role,
            self: b.self,
            labelEventAt: b.labelEventAt,
          }
        : null;
    case "stale":
      return b.record
        ? {
            kind: "stale",
            reason: "head_moved",
            actor: null,
            role: null,
            self: false,
            labelEventAt: null,
          }
        : null;
    default:
      return null;
  }
}

/**
 * D10 and §9: counts only. No team slugs (Phase 0 D19) and no logins beyond the existing `users`.
 */
function storedApprovals(
  a: ApprovalCount | null,
  approvers: ApproverFacts | null,
  enforced: Enforced,
): Record<string, unknown> {
  if (a === null) return {};
  const { currentApprovers: _all, changesRequested: _req, ...phase0 } = a;
  return {
    ...phase0,
    counted: approvers?.counted.length ?? 0,
    notCounted: approvers?.notCounted.length ?? 0,
    changesRequested: approvers?.changesRequestedBy.length ?? 0,
    constraints: enforced.constraints.map((c) => ({
      humans: c.humans,
      teamCount: c.teams.length,
      met: c.met,
      approved: c.approvedCount,
      unverified: c.unverified.map((u) => u.why),
    })),
  };
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
  let query = ctx.db
    .selectFrom("changes")
    .select(["pr_number"])
    .where("repository_id", "=", data.repositoryId)
    .where("state", "=", "open");
  // A push concerns one base branch; a mode change concerns every open PR.
  if (data.scope === "branch") query = query.where("base_ref", "=", data.branch);
  const rows = await query
    .orderBy("pr_updated_at", (ob) => ob.desc().nullsLast())
    .orderBy("pr_number", "desc")
    .limit(FANOUT_MAX + 1)
    .execute();
  if (rows.length > FANOUT_MAX) {
    ctx.log.warn({ outcome: "fanout_truncated", max: FANOUT_MAX }, "policy fanout truncated");
  }
  const chosen = rows.slice(0, FANOUT_MAX);
  for (const [i, row] of chosen.entries()) {
    const common = {
      installationId: data.installationId,
      repositoryId: data.repositoryId,
      owner: data.owner,
      repo: data.repo,
      prNumber: row.pr_number,
    };
    await ctx.queue.send(
      policyEvaluateJob,
      data.scope === "branch"
        ? { ...common, trigger: "base_push", deliveryId: data.deliveryId }
        : { ...common, trigger: "mode" },
      {
        singletonKey:
          data.scope === "branch"
            ? `policy:base:${data.repositoryId}:${row.pr_number}:${data.afterSha}`
            : `policy:mode:${data.repositoryId}:${row.pr_number}:${data.changeId ?? `ceiling-${data.ceilingAt}`}`,
        startAfterSeconds: Math.floor(i / FANOUT_BATCH) * FANOUT_STEP_SECONDS,
      },
    );
  }
  ctx.log.info(
    { outcome: "enqueued", count: chosen.length, scope: data.scope },
    "policy fanout done",
  );
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
