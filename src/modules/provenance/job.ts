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
import { computeProvenance, mcpAgreement } from "./compute.js";
import { fetchPrCommits } from "./fetch.js";
import { renderCheckRunOutput, renderProvenanceSection } from "./render.js";
import { getChangeProvenance, getMcpReport, persistProvenance, setCheckRunId } from "./store.js";

export const PROVENANCE_REFRESH_JOB = "provenance.refresh";
export const PROVENANCE_CHECK_NAME = "graft/provenance";

export const TRIGGERS = [
  "opened",
  "synchronize",
  "reopened",
  "edited",
  "closed",
  "rerequested",
  // Phase 1 step 6 (D15): an MCP `report_provenance` was stored for the head.
  "mcp_report",
] as const;

const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/;

export const refreshSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: z.string().regex(NAME_PART),
  repo: z.string().regex(NAME_PART),
  prNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  trigger: z.enum(TRIGGERS),
  deliveryId: z.string(),
});
export type RefreshData = z.infer<typeof refreshSchema>;

type Outcome = "published" | "stale" | "closed" | "skipped";

async function publishCheckRun(
  octokit: GitHubClient,
  o: {
    owner: string;
    repo: string;
    appId: number;
    headSha: string;
    changeId: string;
    storedId: number | null;
    now: Date;
    output: { title: string; summary: string };
  },
): Promise<number> {
  const body = {
    name: PROVENANCE_CHECK_NAME,
    status: "completed" as const,
    conclusion: "neutral" as const,
    external_id: o.changeId,
    completed_at: o.now.toISOString(),
    output: o.output,
  };
  let id = o.storedId;
  if (id === null) {
    const { data } = await octokit.rest.checks.listForRef({
      owner: o.owner,
      repo: o.repo,
      ref: o.headSha,
      check_name: PROVENANCE_CHECK_NAME,
      app_id: o.appId,
      filter: "latest",
    });
    id = data.check_runs[0]?.id ?? null;
  }
  if (id !== null) {
    await octokit.rest.checks.update({ owner: o.owner, repo: o.repo, check_run_id: id, ...body });
    return id;
  }
  const { data } = await octokit.rest.checks.create({
    owner: o.owner,
    repo: o.repo,
    head_sha: o.headSha,
    ...body,
  });
  return data.id;
}

/** "Make provenance match the PR as it is now": always computed from live API data. */
export async function refreshProvenance(data: RefreshData, ctx: JobContext): Promise<Outcome> {
  const { config } = ctx;
  const done = (outcome: Outcome, extra: Record<string, unknown> = {}): Outcome => {
    ctx.log.info({ outcome, prNumber: data.prNumber, ...extra }, "provenance refresh done");
    return outcome;
  };

  // 1
  const installation = await getActiveInstallation(ctx.db, data.installationId);
  if (!installation) return done("skipped", { reason: "installation inactive" });

  // 2
  let octokit: GitHubClient;
  try {
    octokit = await ctx.github.forInstallation(data.installationId);
  } catch (err) {
    throw toJobError(err, "installation token");
  }

  // 3
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

  // 4
  const now = ctx.clock.now();
  if ((await ensureRepository(ctx.db, data.installationId, pull.base.repo, now)) === "removed") {
    return done("skipped", { reason: "repository removed" });
  }

  // 5
  const { change, applied } = await upsertChangeFromPull(ctx.db, data.repositoryId, pull, now);
  if (!applied) return done("stale", { changeId: change.id, reason: "newer snapshot stored" });
  if (data.trigger === "closed" || pull.state === "closed") {
    return done("closed", { changeId: change.id });
  }

  // 6, 7
  let fetched: Awaited<ReturnType<typeof fetchPrCommits>>;
  try {
    fetched = await fetchPrCommits(octokit, {
      owner: data.owner,
      repo: data.repo,
      prNumber: data.prNumber,
      headSha: pull.head.sha,
      commitsTotal: pull.commits,
    });
  } catch (err) {
    throw toJobError(err, "list commits");
  }
  const result = computeProvenance({
    commits: fetched.commits,
    commitsTotal: pull.commits,
    truncated: fetched.truncated,
    prBody: pull.body,
    prAuthor: pull.user ?? { login: "ghost", type: "User" },
    agentLogins: config.agentLogins,
    agentCoauthorEmails: config.agentCoauthorEmails,
  });

  // 8
  const outcome = await withChangeLock(ctx.db, change.id, async (tx) => {
    const current = await getChange(tx, change.id);
    if (!current || current.head_sha !== pull.head.sha) {
      ctx.log.info({ changeId: change.id }, "stale: head moved");
      return "stale" as const;
    }
    // Same head but a newer snapshot (for example a body edit) was stored meanwhile: its job
    // publishes, this older one must not overwrite it.
    if (current.pr_updated_at !== null && current.pr_updated_at > new Date(pull.updated_at)) {
      ctx.log.info({ changeId: change.id }, "stale: newer snapshot stored");
      return "stale" as const;
    }
    const previous = await getChangeProvenance(tx, change.id);
    // Phase 1 step 6 (D13): the MCP report for this head, compared with what the trailers say.
    const report = await getMcpReport(tx, change.id, pull.head.sha);
    const mcpReport = mcpAgreement(
      {
        headSha: pull.head.sha,
        authorKind: result.authorKind,
        agent: result.fields.agent?.value ?? null,
      },
      report?.agent ? { headSha: pull.head.sha, agent: report.agent } : null,
    );
    const render = {
      headSha: pull.head.sha,
      authorLogin: pull.user?.login ?? "ghost",
      ...(report?.agent && mcpReport !== "none"
        ? {
            mcp: {
              agent: report.agent,
              model: report.model,
              task: report.task_external_id,
              agrees: mcpReport === "agrees",
            },
          }
        : {}),
    };
    await persistProvenance(tx, {
      change: current,
      repositoryId: data.repositoryId,
      repositoryFullName: pull.base.repo.full_name,
      headSha: pull.head.sha,
      result,
      now,
      mcpReport,
    });

    try {
      const comment = await upsertManagedSection(octokit, {
        owner: data.owner,
        repo: data.repo,
        issueNumber: data.prNumber,
        appId: config.githubAppId,
        appBotLogin: config.githubAppSlug ? `${config.githubAppSlug}[bot]` : undefined,
        knownCommentId: current.graft_comment_id,
        section: "provenance",
        markdown: renderProvenanceSection(result, render),
      });
      await tx
        .updateTable("changes")
        .set({ graft_comment_id: comment.commentId })
        .where("id", "=", change.id)
        .execute();

      const checkRunId = await publishCheckRun(octokit, {
        owner: data.owner,
        repo: data.repo,
        appId: config.githubAppId,
        headSha: pull.head.sha,
        changeId: change.id,
        storedId: previous && previous.head_sha === pull.head.sha ? previous.check_run_id : null,
        now,
        output: renderCheckRunOutput(result, render),
      });
      await setCheckRunId(tx, change.id, checkRunId, now);
    } catch (err) {
      // Rolls the transaction back; the retry repeats everything without creating duplicates.
      throw toJobError(err, "publish");
    }
    return "published" as const;
  });

  if (outcome === "published") {
    // D15: tell other modules (policy) that provenance is stored. Outside the lock.
    await ctx.signals.emit(
      {
        kind: "provenance_published",
        installationId: data.installationId,
        repositoryId: data.repositoryId,
        owner: data.owner,
        repo: data.repo,
        prNumber: data.prNumber,
        changeId: change.id,
        headSha: pull.head.sha,
        atMs: ctx.clock.now().getTime(),
      },
      ctx,
    );
  }

  return done(outcome, {
    changeId: change.id,
    headSha: pull.head.sha,
    authorKind: result.authorKind,
    withTrailers: result.counts.withTrailers,
  });
}

export const provenanceRefreshJob = defineJob<RefreshData>({
  name: PROVENANCE_REFRESH_JOB,
  schema: refreshSchema,
  options: { retryLimit: 8, retryDelaySeconds: 30, retryBackoff: true, expireInSeconds: 120 },
  async handle(data, ctx) {
    await refreshProvenance(data, ctx);
  },
});
