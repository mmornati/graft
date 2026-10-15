/**
 * Label-based incident detection (step 6, T5, D10). A labeled or merged PR only triggers a job;
 * the job reads the LIVE PR and parses its body in memory for two strict link forms. Stored:
 * numbers, source, timestamps. Never the body.
 */
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import type { GitHubClient } from "../../github/client-factory.js";
import { toJobError } from "../../github/errors.js";
import { PermanentJobError } from "../../queue/errors.js";
import { defineJob } from "../../queue/job.js";
import { defineWebhookHandler } from "../../webhooks/handler.js";
import { parsePayload } from "../../webhooks/payload.js";
import { ensureRepository, getActiveInstallation } from "../installations/index.js";
import { insertIncident } from "./store.js";

export const INCIDENT_DETECT_JOB = "pilot.incident.detect";
const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const FULL_NAME = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
export const MAX_CULPRITS = 5;

export const detectSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: z.string().regex(NAME_PART),
  repo: z.string().regex(NAME_PART),
  prNumber: z.number().int().positive(),
});
export type DetectData = z.infer<typeof detectSchema>;

const REVERTS = /^Reverts ([\w.-]+)\/([\w.-]+)#(\d+)\s*$/;
const CULPRIT = /^Graft-Culprit:\s*#(\d+)\s*$/;

/**
 * Culprit PR numbers named by a PR body: `Reverts <owner>/<repo>#N` lines for this repository
 * (case-insensitive owner and repo) and `Graft-Culprit: #N` lines. Distinct, in order of
 * appearance, without the PR itself, at most 5.
 */
export function parseCulprits(
  body: string | null,
  o: { owner: string; repo: string; prNumber: number },
): number[] {
  if (!body) return [];
  const out: number[] = [];
  const add = (n: number) => {
    if (n > 0 && n !== o.prNumber && Number.isSafeInteger(n) && !out.includes(n)) out.push(n);
  };
  for (const line of body.split("\n")) {
    const text = line.replace(/\r$/, "");
    const r = REVERTS.exec(text);
    if (r) {
      if (
        (r[1] as string).toLowerCase() === o.owner.toLowerCase() &&
        (r[2] as string).toLowerCase() === o.repo.toLowerCase()
      ) {
        add(Number(r[3]));
      }
      continue;
    }
    const c = CULPRIT.exec(text);
    if (c) add(Number(c[1]));
  }
  return out.slice(0, MAX_CULPRITS);
}

export const hasLabel = (labels: readonly { name: string }[], wanted: string): boolean =>
  labels.some((l) => l.name.toLowerCase() === wanted.toLowerCase());

async function mergedBefore(
  db: JobContext["db"],
  repositoryId: number,
  prNumber: number,
  before: Date,
): Promise<boolean> {
  const live = await db
    .selectFrom("changes")
    .select("id")
    .where("repository_id", "=", repositoryId)
    .where("pr_number", "=", prNumber)
    .where("state", "=", "merged")
    .where("merged_at", "<", before)
    .executeTakeFirst();
  if (live) return true;
  // A baseline run knows merged PRs from before Graft was installed.
  const old = await db
    .selectFrom("review_time_prs as p")
    .innerJoin("review_time_runs as r", "r.id", "p.run_id")
    .select("p.pr_number")
    .where("r.repository_id", "=", repositoryId)
    .where("p.pr_number", "=", prNumber)
    .where("p.state", "=", "merged")
    .executeTakeFirst();
  return old !== undefined;
}

export async function detectIncident(
  data: DetectData,
  ctx: JobContext,
): Promise<"recorded" | "skipped"> {
  const label = ctx.config.incidentLabel;
  if (label === null) return "skipped";
  if (!(await getActiveInstallation(ctx.db, data.installationId))) return "skipped";
  let octokit: GitHubClient;
  try {
    octokit = await ctx.github.forInstallation(data.installationId);
  } catch (err) {
    throw toJobError(err, "installation token");
  }
  let pull: Awaited<ReturnType<GitHubClient["rest"]["pulls"]["get"]>>["data"];
  try {
    pull = (
      await octokit.rest.pulls.get({
        owner: data.owner,
        repo: data.repo,
        pull_number: data.prNumber,
      })
    ).data;
  } catch (err) {
    throw toJobError(err, "pulls.get");
  }
  if (pull.number !== data.prNumber || pull.base.repo.id !== data.repositoryId) {
    throw new PermanentJobError(
      "pull request does not belong to the expected repository",
      "repo_mismatch",
    );
  }
  // The live PR decides, not the payload that triggered the job.
  if (!hasLabel(pull.labels, label)) return "skipped";
  const now = ctx.clock.now();
  if (
    (await ensureRepository(
      ctx.db,
      data.installationId,
      {
        id: pull.base.repo.id,
        full_name: pull.base.repo.full_name,
        private: pull.base.repo.private,
        default_branch: pull.base.repo.default_branch,
      },
      now,
    )) === "removed"
  ) {
    return "skipped";
  }
  const occurredAt = new Date(pull.created_at);
  // A link in the body is unauthenticated text: keep only PRs that Graft knows were merged into
  // this repository before the fix PR was opened, so a body cannot name an arbitrary number.
  const claimed = parseCulprits(pull.body ?? null, data);
  const culprits: number[] = [];
  for (const n of claimed) {
    if (await mergedBefore(ctx.db, data.repositoryId, n, occurredAt)) culprits.push(n);
  }
  const inserted = await ctx.db.transaction().execute(async (tx) => {
    let n = 0;
    if (culprits.length === 0) {
      if (
        await insertIncident(tx, {
          repositoryId: data.repositoryId,
          culpritPrNumber: null,
          fixPrNumber: data.prNumber,
          source: "label",
          severity: null,
          occurredAt,
          recordedAt: now,
        })
      )
        n++;
      return n;
    }
    // A link was added after the label: the unlinked row of this fix PR is replaced.
    await tx
      .deleteFrom("incidents")
      .where("repository_id", "=", data.repositoryId)
      .where("fix_pr_number", "=", data.prNumber)
      .where("culprit_pr_number", "is", null)
      .where("source", "=", "label")
      .execute();
    for (const culprit of culprits) {
      if (
        await insertIncident(tx, {
          repositoryId: data.repositoryId,
          culpritPrNumber: culprit,
          fixPrNumber: data.prNumber,
          source: "label",
          severity: null,
          occurredAt,
          recordedAt: now,
        })
      )
        n++;
    }
    return n;
  });
  ctx.log.info(
    { prNumber: data.prNumber, culprits: culprits.length, inserted },
    "incident detection done",
  );
  return "recorded";
}

export const incidentDetectJob = defineJob<DetectData>({
  name: INCIDENT_DETECT_JOB,
  schema: detectSchema,
  options: { retryLimit: 3 },
  async handle(data, ctx) {
    await detectIncident(data, ctx);
  },
});

const incidentPayload = z.looseObject({
  action: z.enum(["labeled", "closed"]),
  pull_request: z.looseObject({
    number: z.number().int().positive(),
    merged: z.boolean().optional(),
    updated_at: z.string().min(1),
    labels: z.array(z.looseObject({ name: z.string() })).optional(),
  }),
  label: z.looseObject({ name: z.string() }).nullish(),
  repository: z.looseObject({ id: z.number().int().positive(), full_name: FULL_NAME }),
  installation: z.looseObject({ id: z.number().int().positive() }),
});

export const scheduleIncidentDetection = defineWebhookHandler({
  name: "pilot.incident.schedule",
  on: ["pull_request.labeled", "pull_request.closed"] as const,
  async handle(event, ctx) {
    const wanted = ctx.config.incidentLabel;
    if (wanted === null) return;
    const p = parsePayload(incidentPayload, event, ctx.log);
    if (!p) return;
    if (p.action === "labeled") {
      if (p.label?.name.toLowerCase() !== wanted.toLowerCase()) return;
    } else {
      // A merged PR that already carries the label (the label was set while it was open).
      if (p.pull_request.merged !== true || !hasLabel(p.pull_request.labels ?? [], wanted)) return;
    }
    if (!(await getActiveInstallation(ctx.db, p.installation.id))) return;
    const [owner = "", repo = ""] = p.repository.full_name.split("/");
    await ctx.queue.send(
      incidentDetectJob,
      {
        installationId: p.installation.id,
        repositoryId: p.repository.id,
        owner,
        repo,
        prNumber: p.pull_request.number,
      },
      {
        singletonKey: `inc:${p.repository.id}:${p.pull_request.number}:${p.pull_request.updated_at}`,
      },
    );
  },
});
