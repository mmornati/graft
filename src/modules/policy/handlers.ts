/**
 * Handlers treat the payload as a TRIGGER only: they validate its shape, read IDs, and enqueue a
 * job. They never write state or call GitHub; the jobs re-fetch what they need (README §5).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SignalListener } from "../../core/signals.js";
import { defineWebhookHandler } from "../../webhooks/handler.js";
import { parsePayload } from "../../webhooks/payload.js";
import { findChangeByHead } from "../changes/index.js";
import { getActiveInstallation } from "../installations/index.js";
import { type EvaluateData, type FanoutData, policyEvaluateJob, policyFanoutJob } from "./job.js";
import { POLICY_CHECK_NAME } from "./render.js";

const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const FULL_NAME = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const PR_ACTIONS = ["opened", "synchronize", "reopened", "edited", "labeled", "unlabeled"] as const;
const ZERO_SHA = "0".repeat(40);

const pullRequestPayload = z
  .looseObject({
    action: z.enum(PR_ACTIONS),
    number: z.number().int().positive(),
    pull_request: z.looseObject({
      number: z.number().int().positive(),
      head: z.looseObject({ sha: SHA }),
      base: z.looseObject({ ref: z.string() }),
      updated_at: z.string().min(1),
    }),
    label: z.looseObject({ name: z.string() }).nullish(),
    repository: z.looseObject({ id: z.number().int().positive(), full_name: FULL_NAME }),
    installation: z.looseObject({ id: z.number().int().positive() }),
  })
  .refine((p) => p.number === p.pull_request.number, {
    path: ["pull_request", "number"],
    message: "number mismatch",
  });

const reviewPayload = z.looseObject({
  action: z.enum(["submitted", "dismissed"]),
  review: z.looseObject({ id: z.number().int().positive() }),
  pull_request: z.looseObject({ number: z.number().int().positive() }),
  repository: z.looseObject({ id: z.number().int().positive(), full_name: FULL_NAME }),
  installation: z.looseObject({ id: z.number().int().positive() }),
});

const checkRunPayload = z.looseObject({
  action: z.literal("rerequested"),
  check_run: z.looseObject({
    name: z.string(),
    head_sha: SHA,
    app: z.looseObject({ id: z.number().int() }),
    pull_requests: z.array(z.looseObject({ number: z.number().int().positive() })),
  }),
  repository: z.looseObject({ id: z.number().int().positive(), full_name: FULL_NAME }),
  installation: z.looseObject({ id: z.number().int().positive() }),
});

const pathList = z.array(z.string()).optional();
const pushPayload = z.looseObject({
  ref: z.string(),
  deleted: z.boolean().optional(),
  forced: z.boolean().optional(),
  after: z.string(),
  commits: z
    .array(z.looseObject({ added: pathList, modified: pathList, removed: pathList }))
    .optional(),
  repository: z.looseObject({ id: z.number().int().positive(), full_name: FULL_NAME }),
  installation: z.looseObject({ id: z.number().int().positive() }),
});

const sha256_16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner = "", repo = ""] = fullName.split("/");
  return { owner, repo };
}

/** `policy:pr:{repoId}:{pr}:{head}:{baseRef}:{updated_at}:{action}:{sha16(label)}` */
export function scheduleKey(p: {
  repositoryId: number;
  prNumber: number;
  headSha: string;
  baseRef: string;
  updatedAt: string;
  action: string;
  label: string | null;
}): string {
  return `policy:pr:${p.repositoryId}:${p.prNumber}:${p.headSha}:${p.baseRef}:${p.updatedAt}:${p.action}:${sha256_16(p.label ?? "")}`;
}

export const scheduleLabels = ["labeled", "unlabeled"] as const;

export const schedulePolicy = defineWebhookHandler({
  name: "policy.schedule",
  on: [
    "pull_request.opened",
    "pull_request.synchronize",
    "pull_request.reopened",
    "pull_request.edited",
    "pull_request.labeled",
    "pull_request.unlabeled",
  ] as const,
  async handle(event, ctx) {
    const p = parsePayload(pullRequestPayload, event, ctx.log);
    if (!p) return;
    if (!(await getActiveInstallation(ctx.db, p.installation.id))) {
      ctx.log.debug({ installationId: p.installation.id }, "installation inactive; skipping PR");
      return;
    }
    const data: EvaluateData = {
      installationId: p.installation.id,
      repositoryId: p.repository.id,
      ...splitFullName(p.repository.full_name),
      prNumber: p.number,
      trigger: "pr",
      deliveryId: event.deliveryId,
    };
    await ctx.queue.send(policyEvaluateJob, data, {
      singletonKey: scheduleKey({
        repositoryId: data.repositoryId,
        prNumber: data.prNumber,
        headSha: p.pull_request.head.sha,
        baseRef: p.pull_request.base.ref,
        updatedAt: p.pull_request.updated_at,
        action: p.action,
        label: p.label?.name ?? null,
      }),
    });
  },
});

export const reviewPolicy = defineWebhookHandler({
  name: "policy.review",
  on: ["pull_request_review.submitted", "pull_request_review.dismissed"] as const,
  async handle(event, ctx) {
    const p = parsePayload(reviewPayload, event, ctx.log);
    if (!p) return;
    if (!(await getActiveInstallation(ctx.db, p.installation.id))) return;
    await ctx.queue.send(
      policyEvaluateJob,
      {
        installationId: p.installation.id,
        repositoryId: p.repository.id,
        ...splitFullName(p.repository.full_name),
        prNumber: p.pull_request.number,
        trigger: "review",
        deliveryId: event.deliveryId,
      },
      {
        singletonKey: `policy:review:${p.repository.id}:${p.pull_request.number}:${p.review.id}:${p.action}`,
      },
    );
  },
});

export const rerequestPolicy = defineWebhookHandler({
  name: "policy.rerequest",
  on: ["check_run.rerequested"] as const,
  async handle(event, ctx) {
    const p = parsePayload(checkRunPayload, event, ctx.log);
    if (!p) return;
    if (p.check_run.name !== POLICY_CHECK_NAME || p.check_run.app.id !== ctx.config.githubAppId) {
      return;
    }
    if (!(await getActiveInstallation(ctx.db, p.installation.id))) return;
    const prNumber =
      p.check_run.pull_requests[0]?.number ??
      (await findChangeByHead(ctx.db, p.repository.id, p.check_run.head_sha))?.pr_number;
    if (prNumber === undefined) {
      ctx.log.info({ headSha: p.check_run.head_sha }, "rerequested check run matches no PR");
      return;
    }
    await ctx.queue.send(
      policyEvaluateJob,
      {
        installationId: p.installation.id,
        repositoryId: p.repository.id,
        ...splitFullName(p.repository.full_name),
        prNumber,
        trigger: "rerequested",
        deliveryId: event.deliveryId,
      },
      // One re-run per PR per minute: a flood of rerequests is bounded.
      {
        singletonKey: `policy-rerun:${p.repository.id}:${prNumber}:${Math.floor(ctx.clock.now().getTime() / 60_000)}`,
      },
    );
  },
});

/** A push worth re-evaluating open PRs for (D18). */
export function pushTouchesPolicy(p: z.infer<typeof pushPayload>): boolean {
  if (!p.ref.startsWith("refs/heads/")) return false;
  if (p.deleted === true) return false;
  if (!/^[0-9a-f]{40}$/.test(p.after) || p.after === ZERO_SHA) return false;
  const commits = p.commits ?? [];
  // The payload lists at most 20 commits, so 20 or more may be truncated.
  if (p.forced === true || commits.length >= 20) return true;
  return commits.some((c) =>
    [c.added, c.modified, c.removed].some((l) => l?.includes("graft.yaml")),
  );
}

export const basePushPolicy = defineWebhookHandler({
  name: "policy.base-push",
  on: ["push"] as const,
  async handle(event, ctx) {
    const p = parsePayload(pushPayload, event, ctx.log);
    if (!p) return;
    if (!pushTouchesPolicy(p)) return;
    if (!(await getActiveInstallation(ctx.db, p.installation.id))) return;
    const data: FanoutData = {
      installationId: p.installation.id,
      repositoryId: p.repository.id,
      ...splitFullName(p.repository.full_name),
      branch: p.ref.slice("refs/heads/".length),
      afterSha: p.after,
      deliveryId: event.deliveryId,
    };
    await ctx.queue.send(policyFanoutJob, data, {
      singletonKey: `policy-push:${data.repositoryId}:${p.ref}:${p.after}`,
    });
  },
});

/** Re-evaluate when a card or provenance is published for the head (D15). */
export const onChangeSignal: SignalListener = async (s, ctx) => {
  // A vote changes no policy fact (step 6): the pilot module listens to it, policy does not.
  if (s.kind === "feedback_recorded") return;
  await ctx.queue.send(
    policyEvaluateJob,
    {
      installationId: s.installationId,
      repositoryId: s.repositoryId,
      owner: s.owner,
      repo: s.repo,
      prNumber: s.prNumber,
      trigger: s.kind === "intent_published" ? "intent" : "provenance",
    },
    { singletonKey: `policy:sig:${s.kind}:${s.changeId}:${s.headSha}:${s.atMs}` },
  );
};
