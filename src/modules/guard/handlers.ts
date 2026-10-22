/**
 * Guard triggers (Phase 1 step 4, D13). A payload is only a trigger: it decides whether to
 * enqueue, never what is stored. The jobs re-read the default branch, the history and the CI
 * results from the API. PR checks are most of the `check_run` volume, so a check whose branch hint
 * is not the default branch is dropped here, and so are Graft's own check runs.
 */
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import { defineWebhookHandler } from "../../webhooks/handler.js";
import { parsePayload } from "../../webhooks/payload.js";
import { getActiveInstallation } from "../installations/index.js";
import { scheduleObserve } from "./observe.js";
import { guardTrackJob } from "./track.js";

const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const FULL_NAME = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const ZERO_SHA = "0".repeat(40);
/** GitHub lists at most this many branches in a `status` payload. */
const STATUS_BRANCHES_CAP = 10;

const repository = z.looseObject({
  id: z.number().int().positive(),
  full_name: FULL_NAME,
  default_branch: z.string().min(1),
});
const installation = z.looseObject({ id: z.number().int().positive() });

const pushPayload = z.looseObject({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  forced: z.boolean().optional(),
  deleted: z.boolean().optional(),
  repository,
  installation,
});

const checkRunPayload = z.looseObject({
  action: z.literal("completed"),
  check_run: z.looseObject({
    head_sha: SHA,
    app: z.looseObject({ id: z.number().int() }).nullish(),
    check_suite: z.looseObject({ head_branch: z.string().nullish() }).nullish(),
  }),
  repository,
  installation,
});

const checkSuitePayload = z.looseObject({
  action: z.literal("completed"),
  check_suite: z.looseObject({ head_sha: SHA, head_branch: z.string().nullish() }),
  repository,
  installation,
});

const statusPayload = z.looseObject({
  sha: SHA,
  branches: z.array(z.looseObject({ name: z.string() })),
  repository,
  installation,
});

function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner = "", repo = ""] = fullName.split("/");
  return { owner, repo };
}

async function observe(
  ctx: JobContext,
  p: { repository: z.infer<typeof repository>; installation: { id: number } },
  sha: string,
): Promise<void> {
  if (!(await getActiveInstallation(ctx.db, p.installation.id))) return;
  await scheduleObserve(ctx, {
    installationId: p.installation.id,
    repositoryId: p.repository.id,
    ...splitFullName(p.repository.full_name),
    sha,
  });
}

export const guardPush = defineWebhookHandler({
  name: "guard.push",
  on: ["push"] as const,
  async handle(event, ctx) {
    if (!ctx.config.guardDetection) return;
    const p = parsePayload(pushPayload, event, ctx.log);
    if (!p) return;
    if (p.ref !== `refs/heads/${p.repository.default_branch}`) return;
    if (p.deleted === true || !SHA.safeParse(p.after).success || p.after === ZERO_SHA) return;
    if (!(await getActiveInstallation(ctx.db, p.installation.id))) return;
    const before = SHA.safeParse(p.before).success && p.before !== ZERO_SHA ? p.before : null;
    await ctx.queue.send(
      guardTrackJob,
      {
        installationId: p.installation.id,
        repositoryId: p.repository.id,
        ...splitFullName(p.repository.full_name),
        branch: p.repository.default_branch,
        after: p.after,
        before,
        forced: p.forced === true,
        deliveryId: event.deliveryId,
      },
      // A replay of the same push is one job; another push has another (before, after) pair.
      { singletonKey: `guard:track:${p.repository.id}:${before ?? "none"}:${p.after}` },
    );
  },
});

export const guardCheckRun = defineWebhookHandler({
  name: "guard.check_run",
  on: ["check_run.completed"] as const,
  async handle(event, ctx) {
    if (!ctx.config.guardDetection) return;
    const p = parsePayload(checkRunPayload, event, ctx.log);
    if (!p) return;
    if (p.check_run.app?.id === ctx.config.githubAppId) return;
    if (p.check_run.check_suite?.head_branch !== p.repository.default_branch) return;
    await observe(ctx, p, p.check_run.head_sha);
  },
});

export const guardCheckSuite = defineWebhookHandler({
  name: "guard.check_suite",
  on: ["check_suite.completed"] as const,
  async handle(event, ctx) {
    if (!ctx.config.guardDetection) return;
    const p = parsePayload(checkSuitePayload, event, ctx.log);
    if (!p) return;
    if (p.check_suite.head_branch !== p.repository.default_branch) return;
    await observe(ctx, p, p.check_suite.head_sha);
  },
});

export const guardStatus = defineWebhookHandler({
  name: "guard.status",
  on: ["status"] as const,
  async handle(event, ctx) {
    if (!ctx.config.guardDetection) return;
    const p = parsePayload(statusPayload, event, ctx.log);
    if (!p) return;
    // `branches` lists branches that CONTAIN the SHA, at most 10, so a full list may have cut the
    // default branch (step 4 review 1, finding 3). It is only a hint: with 10 entries the job
    // decides, since it keeps only SHAs on the tracked default branch (`not_on_default_branch`).
    const named = p.branches.some((b) => b.name === p.repository.default_branch);
    if (!named && p.branches.length < STATUS_BRANCHES_CAP) return;
    await observe(ctx, p, p.sha);
  },
});
