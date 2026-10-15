import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import { withChangeLock } from "../../db/locks.js";
import type { GitHubClient } from "../../github/client-factory.js";
import { toJobError } from "../../github/errors.js";
import { upsertManagedSection } from "../../github/managed-comment.js";
import { PermanentJobError } from "../../queue/errors.js";
import { defineJob } from "../../queue/job.js";
import { getChange, type LivePull, upsertChangeFromPull } from "../changes/index.js";
import { ensureRepository, getActiveInstallation } from "../installations/index.js";
import { fetchIntentInputs } from "./fetch.js";
import {
  type CardResult,
  defaultGenerateOptions,
  prepareCardInputs,
  runCard,
  unavailableResult,
} from "./generate.js";
import { PROMPT_VERSION } from "./prompts.js";
import {
  INTENT_CHECK_ACTIONS,
  INTENT_CHECK_NAME,
  renderIntentCheckOutput,
  renderIntentSection,
  renderPendingSection,
} from "./render.js";
import { intentRepoSettings } from "./settings.js";
import {
  findCard,
  type IntentCardRow,
  latestPublishedCard,
  markPublished,
  publishedCheckRunForHead,
  recordPendingDisplay,
  rowToView,
  saveCard,
  tokensUsedToday,
} from "./store.js";

export const INTENT_GENERATE_JOB = "intent.generate";
export const INTENT_TRIGGERS = [
  "opened",
  "synchronize",
  "reopened",
  "edited",
  "rerequested",
  "retry",
] as const;

const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/;

/** The job data holds IDs and names only: never text, file content or a diff. */
export const generateSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: z.string().regex(NAME_PART),
  repo: z.string().regex(NAME_PART),
  prNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  trigger: z.enum(INTENT_TRIGGERS),
  attempt: z.number().int().min(0).max(2),
  deliveryId: z.string(),
});
export type GenerateData = z.infer<typeof generateSchema>;

export type IntentOutcome = "published" | "cached" | "stale" | "closed" | "skipped";

export async function generateIntent(data: GenerateData, ctx: JobContext): Promise<IntentOutcome> {
  const { config } = ctx;
  const startedAtMs = Date.now();
  const done = (outcome: IntentOutcome, extra: Record<string, unknown> = {}): IntentOutcome => {
    ctx.log.info({ outcome, prNumber: data.prNumber, ...extra }, "intent generate done");
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

  // 2. Change row.
  const { change, applied } = await upsertChangeFromPull(ctx.db, data.repositoryId, pull, now);
  if (!applied) return done("stale", { changeId: change.id, reason: "newer snapshot stored" });
  if (pull.state === "closed") return done("closed", { changeId: change.id });

  // 3. A retry for a head that is no longer current is superseded.
  if (data.trigger === "retry" && pull.head.sha !== data.headSha) {
    return done("stale", { changeId: change.id, reason: "retry superseded" });
  }

  // 4. Inputs.
  const settings = await intentRepoSettings(ctx, {
    repositoryId: data.repositoryId,
    installationId: data.installationId,
    owner: data.owner,
    repo: data.repo,
    baseSha: pull.base.sha ?? pull.base.ref,
  });
  let taskIssueNumber: number | null = null;
  if (change.task_id) {
    const task = await ctx.db
      .selectFrom("tasks")
      .select("issue_number")
      .where("id", "=", change.task_id)
      .executeTakeFirst();
    taskIssueNumber = task?.issue_number ?? null;
  }
  let inputs: Awaited<ReturnType<typeof fetchIntentInputs>>;
  try {
    inputs = await fetchIntentInputs(octokit, {
      owner: data.owner,
      repo: data.repo,
      pull,
      taskIssueNumber,
    });
  } catch (err) {
    throw toJobError(err, "list files");
  }
  const opts = defaultGenerateOptions(config, settings.floor);
  opts.log = ctx.log;
  opts.startedAtMs = startedAtMs;
  const prepared = prepareCardInputs(inputs, opts);

  const fresh = (current: Awaited<ReturnType<typeof getChange>>): boolean =>
    !!current &&
    current.head_sha === pull.head.sha &&
    !(current.pr_updated_at !== null && current.pr_updated_at > new Date(pull.updated_at));

  // 5. Cache: a good card for the same inputs is reused without a model call.
  const existing = await findCard(ctx.db, {
    changeId: change.id,
    headSha: pull.head.sha,
    promptVersion: PROMPT_VERSION,
    inputHash: prepared.inputHash,
  });
  let card: IntentCardRow;
  let result: CardResult | null = null;
  let cached = false;
  if (existing && existing.status === "ok") {
    card = existing;
    cached = true;
  } else {
    // 6. Pre-spend check: do not pay for a card that is already out of date.
    if (!fresh(await getChange(ctx.db, change.id))) {
      return done("stale", { changeId: change.id, reason: "before model calls" });
    }

    // 7.1 Outdated note (D11): a reviewer must not read the old card as the new head's.
    const previous = await latestPublishedCard(ctx.db, change.id);
    if (previous && previous.head_sha !== pull.head.sha) {
      const noted = await withChangeLock(ctx.db, change.id, async (tx) => {
        if (!fresh(await getChange(tx, change.id))) return false;
        const current = await getChange(tx, change.id);
        try {
          const c = await upsertManagedSection(octokit, {
            owner: data.owner,
            repo: data.repo,
            issueNumber: data.prNumber,
            appId: config.githubAppId,
            appBotLogin: config.githubAppSlug ? `${config.githubAppSlug}[bot]` : undefined,
            knownCommentId: current?.graft_comment_id ?? null,
            section: "intent",
            markdown: renderPendingSection({
              headSha: pull.head.sha,
              previousHeadSha: previous.head_sha,
            }),
          });
          await tx
            .updateTable("changes")
            .set({ graft_comment_id: c.commentId })
            .where("id", "=", change.id)
            .execute();
          // The note is a display too: a reaction made while it is shown is not a vote on the
          // previous card (it is dropped like one made on an "unavailable" notice).
          await recordPendingDisplay(tx, {
            changeId: change.id,
            cardId: previous.id,
            now: ctx.clock.now(),
          });
        } catch (err) {
          throw toJobError(err, "publish pending note");
        }
        return true;
      });
      if (!noted) return done("stale", { changeId: change.id, reason: "before pending note" });
    }

    // 7.2 Budget, 7.3 model, 7.4 save (outside the lock, D10).
    const budget = settings.dailyTokenBudget;
    if (
      budget > 0 &&
      (await tokensUsedToday(ctx.db, data.repositoryId, now)) + prepared.estimatedTokens > budget
    ) {
      result = unavailableResult(prepared, "budget_exceeded");
    } else {
      result = await runCard(prepared, ctx.llm, opts);
    }
    card = await saveCard(ctx.db, {
      changeId: change.id,
      headSha: pull.head.sha,
      result,
      now,
    });
  }

  // 8. Publish.
  // The notice says "retries automatically" only when a retry job was really queued: a deduplicated
  // send (null) means none was added by this run. A pending-only singleton is not available on our
  // `standard` queues (README §7, pg-boss 12), hence the 5-minute bucket in the key: two triggers
  // for the same inputs within one bucket queue one retry, and a retry that already completed
  // cannot swallow a failure in a later bucket (it starts at least 300 s later, so in a later
  // bucket). Known limit, accepted: two triggers on either side of a bucket boundary queue two
  // retry chains (at most two per boundary, each capped at `attempt < 2`), because the queue
  // offers no pending-only dedupe here; a duplicate chain republishes the same card idempotently.
  let retryScheduled = false;
  if (card.status === "unavailable" && (result?.retryable ?? false) && data.attempt < 2) {
    const id = await ctx.queue.send(
      intentGenerateJob,
      { ...data, trigger: "retry", headSha: pull.head.sha, attempt: data.attempt + 1 },
      {
        singletonKey: `intent-retry:${change.id}:${pull.head.sha}:${prepared.inputHash.slice(0, 16)}:${data.attempt + 1}:${Math.floor(ctx.clock.now().getTime() / 300_000)}`,
        startAfterSeconds: 300 * (data.attempt + 1),
      },
    );
    retryScheduled = id !== null;
  }
  const published = await withChangeLock(ctx.db, change.id, async (tx) => {
    const current = await getChange(tx, change.id);
    if (!current || !fresh(current)) {
      ctx.log.info({ changeId: change.id }, "stale: head moved or newer snapshot stored");
      return false;
    }
    const view = rowToView(card);
    try {
      // Order matters (README §7): the check run first, then the comment, then the display. A
      // failure of either call leaves the old comment and no new display row, so a retry
      // publishes once. The check run's buttons attribute exactly through `external_id`.
      const body = {
        name: INTENT_CHECK_NAME,
        status: "completed" as const,
        conclusion: "neutral" as const,
        external_id: card.id,
        completed_at: now.toISOString(),
        output: renderIntentCheckOutput(view, { retryScheduled }),
        actions: card.status === "ok" ? [...INTENT_CHECK_ACTIONS] : [],
      };
      let checkRunId = await publishedCheckRunForHead(tx, change.id, pull.head.sha);
      if (checkRunId === null) {
        const listed = await octokit.rest.checks.listForRef({
          owner: data.owner,
          repo: data.repo,
          ref: pull.head.sha,
          check_name: INTENT_CHECK_NAME,
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
          head_sha: pull.head.sha,
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
        section: "intent",
        markdown: renderIntentSection(view, { retryScheduled }),
      });
      // The moment the card is really on screen: right after the comment write.
      const shownAt = ctx.clock.now();
      await tx
        .updateTable("changes")
        .set({ graft_comment_id: comment.commentId })
        .where("id", "=", change.id)
        .execute();
      await markPublished(
        tx,
        { id: card.id, changeId: change.id, status: card.status },
        { commentId: comment.commentId, checkRunId, now: shownAt },
      );
    } catch (err) {
      // Rolls the transaction back; the retry finds the saved card and calls no model.
      throw toJobError(err, "publish");
    }
    return true;
  });
  if (!published) return done("stale", { changeId: change.id, reason: "before publish" });

  const view = rowToView(card);
  return done(cached ? "cached" : "published", {
    changeId: change.id,
    headSha: pull.head.sha,
    status: view.status,
    final: view.risk.final,
    floor: view.risk.floor,
    verifierStatus: view.verifier.status,
    calls: result?.usage.calls ?? 0,
    inputTokens: result?.usage.inputTokens ?? 0,
    outputTokens: result?.usage.outputTokens ?? 0,
  });
}

export const intentGenerateJob = defineJob<GenerateData>({
  name: INTENT_GENERATE_JOB,
  schema: generateSchema,
  options: { retryLimit: 5, retryDelaySeconds: 30, retryBackoff: true, expireInSeconds: 900 },
  async handle(data, ctx) {
    await generateIntent(data, ctx);
  },
});
